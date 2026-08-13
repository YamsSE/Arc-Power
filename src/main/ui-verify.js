// Arc Power - dev-only UI verification (`electron . --ui-verify`).
//
// Drives the REAL window (renderer + preload + IPC + MockBackend) through
// the M2a/M2b-B/M2C-B/M2D/M3-A product flows and asserts the outcomes:
//   1. shell renders (sidebar + header); M3-A: the sidebar brand is the
//      "Arc Power" text with the small blue accent bar BELOW it (
//      preferred variant - no logo image);
//   1b. M2C-B B3: the header line below the GPU name is "Arc Power Ver.
//       1.0.1" (app:version IPC + the display suffix - the IPC
//       keeps the bare semver; M5: displayVersion renders ' Beta' for the
//       -beta.x line, nothing for a stable - M17e round-2 N1: the pinned
//       text is EXACTLY 'Arc Power Ver. 1.0.1' - no Beta) - the driver
//       version + date live in the
//       dashboard GPU card 'Driver version' kv ("32.0.101.8861 - Jul 05,
//       2026" from the mock driver-info fixture); M4-H: the GPU card title
//       is 'GPU' with the name in a 'GPU' kv row - the Driver version row
//       moved OUT of the card (the health card keeps it); no PCI ID
//       anywhere;
//       M2C-B B2: NO capsSummary chips footer on the device card; M2C-B B8:
//       a 'Memory clock' kv row next to 'Graphics clock'; memory-clock
//       readout next to core clock; M3-A: the header has NO status dot and
//       NO "Service Status" label (the IGS indicator is gone);
//   1c. M3-A + M3-C-I + M16: the dashboard shows the general GPU STATUS
//       card (five rows: Device detected / Driver installed / OC status
//       (M16 rename; the stock-state verdict) / OC waiver / Arc Power
//       working - the "Clocks normal" row is REMOVED) - the merged Service
//       Status card is GONE, as is everything IGS (dot, half-state note,
//       toggle button). The driver row detail is version + date like the
//       device card; the app row healthy detail is "App & Service Running".
//   2. Tuning (renamed from Overclocking, M4-D2): control cards render from
//      capability ranges; the page-title is 'Tuning'; the OC-mode row is a
//      flex row with the Stock/Advanced pill LEFT and the "Tuning | Fan
//      Curve" view pill RIGHT (same height - the pills' getBoundingClientRect
//      tops are pinned equal); M2b-B: the freq card title is the M4-B 'Core
//      clock' name (the M17e Offset|Lock toggle is the input presentation,
//      not the name), the floating Apply is hidden when clean and appears
//      when dirty (force-hidden in Lock mode);
//   3. first Apply shows the warranty-waiver dialog; Accept persists the
//      waiver; the apply succeeds and the state read-back refreshes; the
//      per-control toast count is exactly 1 (the other three controls are
//      no-ops and stay silent - M2b-B suppression);
//   4. a second apply does NOT re-show the dialog;
//   5. per-card reset-to-default + apply round-trips the default;
//   5b. M2C-B F3 instant apply: ONE attempt, no retry note, no progress
//       label - an io-failed apply fails instantly with the composed
//       refusal toast (plain "The GPU driver refused the change" + the
//       error code); M3-C-G: the per-control chips are hidden until the
//       first apply, then green "Applied" (value == last applied) or warn
//       "Unapplied" - the applied reference clears them even while the
//       driver read-back lags (B5); M3-C-F: the "Driver:" readout refreshes
//       from the fresh state after an apply without navigating away;
//   6. fan editor (the Tuning page's "Fan Curve" sub-view - #/fan redirects
//      to the tuning page with the fan view active): mode toggle, add point,
//      preset, apply; M2C-B B1: the right-side 0-100% axis renders outside
//      the plot;
//   7. a failed fan apply surfaces the mapped OcErrorCode message (not the
//      raw backend message);
//   8. startup (Run-value) channels: startup-get derivation + startup-set
//      round trip + validation;
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
//      slider max 115 C (M17d FLIP (round-3 N3) - the a770's ADVANCED TL is
//      the restored KMD ceiling 115, the M17c listed-row 90 cap is removed);
//      setting PL 300 and applying SKIPS the per-apply
//      confirm (double-dialog decision - the mode-enable confirm already
//      warned) and the read-back sticks at 300 W; restored to 210 W after.
//  12b. M3-C-E stock variant (RID_MOCK_STOCK_MODE=1): sliders pinned to the
//      standard limits (252 W / 90 C), no extendedRanges flag, and a direct
//      300 W apply REFUSES with the mode message - device untouched, no
//      dead-end confirm dialog.
//  13. M2C-C worker-apply toast variant (RID_MOCK_WORKER_APPLY=1, runs on
//      top of the extended variant): before the apply, an info toast
//      explains "Administrator approval is needed to apply GPU settings."
//  14. M2D featureset dropdown (mock mode): present with all 4 files, the
//      live swap round trip swaps the whole UI surface to b580 percent
//      units and back (waiver preserved); the mem-clock pins track the
//      a770 featureset (2187 MHz).
//  15. M2D featureset variants (RID_MOCK_FEATURESET=b580|pro-b50|arc-igpu):
//      runFeaturesetVerify - a reduced flow per device line (OC cards /
//      no-OC note, fan editor / read-only / no-fan, monitoring, swap round
//      trip, b580 percent-unit apply).
//  16. M3-A/M3-B Tweaks page: the registry-hacks catalog renders with live
//      (mock) states - mpo=Off, hags=Active, game-dvr=Default,
//      fullscreen-optimizations=Active; applyable entries get working
//      Enable/Disable/Revert buttons (mock apply - no elevation), fullscreen
//      stays read-only; one apply round trip refreshes the card state.
//  17. M3-B tweaks-apply variant (RID_MOCK_TWEAKS_APPLY=1): the full apply
//      flow - every entry through enable/disable/revert with per-step
//      toasts + state refresh; with RID_MOCK_REGAPPLY_FAIL='<id>:<action>'
//      the honest partial-failure path, with RID_MOCK_REGAPPLY_CANCEL=1 the
//      honest UAC-decline path.
//  18. M4-A/M4-B waiver-prompt variants: every mock session boots with a
//      DETERMINISTIC waiver state (session-seeded in main.js, pre-window -
//      the persisted variant never races the renderer's first caps query).
//      M4-B ("please prompt it when the Program opens"): the boot
//      waiver prompt appears in EVERY variant - CANCELLED here in the
//      unaccepted sessions (default / stock / extended / worker / featureset
//      / tweaks variants), ACCEPTED under RID_MOCK_WAIVER_BOOT_ACCEPT=1
//      (row green, no dialog anywhere after), and shown in its ACCEPTED
//      state under RID_MOCK_WAIVER_PERSISTED=1 - title + 'Status: Accepted'
//      line + single OK, clicked here (persisted acceptance at boot: the
//      boot prompt appears as a reminder, never a re-accept). The waiver
//      STATUS lives ONLY in the dashboard GPU Status card row ("OC waiver:
//      Accepted / Not Accepted", green/red - correction, mid-M4-A): the
//      OC and Fan pages render NO waiver status (the apply-time dialog gate
//      only); the unaccepted row is clickable (opens the waiver dialog;
//      Cancel leaves it red and the next apply still gates), the accepted
//      row has no click action, and the row flips green IN PLACE on the
//      caps-change re-render.
//  19. M4-A fan-gate variant (RID_MOCK_FAN_GATE=1): the unaccepted-waiver fan
//      apply regression - the waiver dialog appears on the first fan apply
//      (Cancel -> aborted with the honest toast, device untouched; Accept ->
//      the apply lands and the dashboard waiver row flips green), plus the
//      G2 self-heal: after a waiver-not-set failure the store flag flips
//      back to unaccepted (row red again) and the NEXT apply re-shows the
//      dialog (the "fan applies fail without a prompt" bug).
//  20. M4-B/M17e: (a) the dashboard health row is renamed "OC status" (was "OC
//      working"; M16: the row now shows the STOCK-STATE verdict); (b) the
//      freq offset ranges mirror into the negative half
//      (a770 -300..300) - the slider reaches the negative half, applies and
//      reads back -100 MHz; (c) M17e: the M4-B Offset/Clock toggle DIES
//      with the Clock mode (the pure/clock.ts helpers were removed) - the
//      freq card's toggle is Offset|Lock: Lock mode renders the gpuLock
//      editor INSIDE the card (the M17d standalone card is folded in), the
//      mode switch resets the other side IN THE DRAFT, the lock apply is
//      the ATOMIC payload (offsets 0 ride along), the offset apply carries
//      the (0,0) unlock, the floating apply is force-hidden in Lock mode,
//      the editor bounds come from caps.lockRange; (d) M4J clarification:
//      the vfCurve/vramVoltOffset expert rows are REMOVED -
//      the Advanced section renders ONLY on vramFreqOffset devices (b580 =
//      the VRAM clock editor) and is GONE on Alchemist (the OC-mode pill
//      stays on every device); (e) the b580 variant pins the mirrored freq
//      range (-500..500) + volt % range (-100..100) with percent units
//      intact + the VRAM-OC editor round trip + the NO-TOGGLE offset card.
//  21. M4-B: the Advanced OC Mode warning is a ONCE-only gate - the
//      disclaimer shows ONLY on the first Stock->Advanced toggle (Cancel
//      keeps stock; it re-asks until Enable), the acceptance is PERSISTED
//      (advanced-mode-accepted-set), and neither a later toggle in the same
//      session nor a later BOOT (RID_MOCK_ADVANCED_ACCEPTED=1 seeds the
//      accepted store) ever shows it again. Stock variant: full once-flow.
//      Knob variant: boot-persisted acceptance -> toggle shows no dialog.
// This script is dev tooling only - it always uses MockBackend (it never
// touches hardware) and exists to catch DOM-wiring regressions that unit
// tests cannot. Profile rows created here are cleaned up before exit.

import { app, screen } from 'electron';

// M4-D2 (§1): the close-to-tray REAL close probe DESTROYS the window as its
// final step - without a 'window-all-closed' handler Electron would
// auto-quit right there, BEFORE the variant's final "UI VERIFY OK" print +
// app.exit(0). Keep the app alive in --ui-verify ONLY (the variant exits
// explicitly; in product mode the default quit behavior is untouched).
if (process.argv.includes('--ui-verify')) {
  app.on('window-all-closed', () => { /* keep alive - the variant exits via app.exit(0) */ });
}

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

/**
 * M4-D2 (§1): the close-to-tray REAL close-interception probe - a SHARED
 * final step invoked after EVERY ui-verify variant entry point (plan-review
 * M6: it covers all 11 variants, not just the default). Drives the REAL
 * BrowserWindow directly:
 *   1. enable closeToTray (the mock store updates the SYNC cache the close
 *      handler reads - run 1's fix);
 *   2. win.close() -> the window must NOT be destroyed and must be hidden
 *      (event.preventDefault() + win.hide() in the same tick);
 *   3. win.show() restores it;
 *   4. disable closeToTray -> win.close() -> the window IS destroyed (the
 *      app then exits - this is the last step of every variant).
 * The probe runs BEFORE the final "UI VERIFY OK" print so a failure still
 * surfaces as a thrown UiVerifyFailure.
 */
async function runCloseToTrayProbe(win) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const fail = (msg) => { throw new UiVerifyFailure(msg); };
  console.log('[ui-verify] close-to-tray probe: enabling closeToTray (real close interception)');
  await js(`window.arcPower.profilesSettingsSave({ closeToTray: true })`);
  await sleep(400);
  if (win.isDestroyed()) fail('close-to-tray probe: the window was already destroyed before the close');
  win.close();
  await sleep(600);
  if (win.isDestroyed()) {
    fail('close-to-tray probe: win.close() DESTROYED the window while closeToTray was ON (the close handler must preventDefault + hide in the same tick)');
  }
  if (win.isVisible()) {
    fail('close-to-tray probe: the window is still VISIBLE after close() with closeToTray on (expected hidden to the tray)');
  }
  win.show();
  await sleep(400);
  if (!win.isVisible()) fail('close-to-tray probe: win.show() did not restore the window');
  console.log('[ui-verify] close-to-tray probe: close() hid the window (not destroyed), show() restored it - now disabling closeToTray');
  await js(`window.arcPower.profilesSettingsSave({ closeToTray: false })`);
  await sleep(400);
  win.close();
  await sleep(600);
  if (!win.isDestroyed()) {
    fail('close-to-tray probe: win.close() with closeToTray OFF did not destroy the window (the handler must only intercept while closeToTray is on)');
  }
  console.log('[ui-verify] close-to-tray probe: close() with closeToTray off destroyed the window - probe OK');
}

// M4-A/M4-B/M4-D: the shared waiver boot-step - MUST run in EVERY ui-verify
// variant BEFORE its own assertions (F4: the extended/stock/featureset
// variants assert modal absence around applies; the boot prompt would
// otherwise be the modal being clicked or asserted there). Every mock
// session boots with a deterministic waiver state (session-seeded in
// main.js BEFORE the window exists - the persisted variant never races the
// renderer's first caps query, F2). M4-D (PERMANENT acceptance -
// "skipped IF permanently accepted after accepting once"):
//   - RID_MOCK_WAIVER_PERSISTED=1 -> the store is ACCEPTED at boot: the boot
//     prompt is SKIPPED ENTIRELY (the accepted-state reminder dialog is
//     REMOVED - the dashboard health row remains the status display); this
//     step asserts NO modal ever appears after the boot sequence lands;
//   - RID_MOCK_WAIVER_PERSISTED=1 + RID_MOCK_WAIVER_LOST=1 (M4-B user fix,
//     M4-D update) -> the store STILL says accepted and the DRIVER lost the
//     waiver: the boot probe (probeWaiverState) now RESTORES the driver
//     waiver instead of clearing the store (M4-D PERMANENT acceptance - the
//     consent stands, the store is never flipped to false), so the boot
//     prompt is STILL skipped (same as the plain persisted variant) and
//     waiver-get reads accepted (the restore is pinned);
//   - RID_MOCK_WAIVER_BOOT_ACCEPT=1 -> the session is unaccepted at boot:
//     the prompt appears exactly once and this step ACCEPTS it (health row
//     green, no dialog anywhere after);
//   - default -> the prompt appears exactly once and this step CANCELS it
//     (row red, the first apply re-shows the dialog - the classic flow).
// Returns true when the session booted with the waiver accepted.
async function bootWaiverStep(win, js, waitFor) {
  const persisted = process.env.RID_MOCK_WAIVER_PERSISTED === '1';
  const waiverLost = process.env.RID_MOCK_WAIVER_LOST === '1';
  const bootAccept = process.env.RID_MOCK_WAIVER_BOOT_ACCEPT === '1';
  // M4-B step-4 F1/F5a: the boot dialog's .modal-device line must carry the
  // VRAM-suffixed name (mock caps.deviceName = formatDeviceName(...)) - the
  // regression pin for the caps-vs-device divergence. Featureset-aware:
  // a770 -> "16GB GDDR6" (the mock models the 16 GB config; the REAL card on
  // this machine is the 8 GB config - its driver qwMemorySize ~7.91 GiB
  // ceils to "8GB" via formatDeviceName; M4-I S1 contract),
  // b580/pro-b50 -> "12GB GDDR6" (fold r2.2: the pro-b50 token is covered),
  // arc-igpu -> plain (no VRAM).
  const fsId = process.env.RID_MOCK_FEATURESET;
  // M17c/M17d: the a750 featuresets (8 GiB - the ASRock Challenger + the
  // Acer AIB variant configs) join the suffix table.
  const expectedSuffix = fsId === 'b580' || fsId === 'pro-b50' ? '12GB GDDR6'
    : (fsId === 'a750' || fsId === 'acer-a750') ? '8GB GDDR6'
    : fsId === 'arc-igpu' ? null
    : '16GB GDDR6';
  const pinDeviceLine = async () => {
    const deviceText = await js(`document.querySelector('.modal .modal-device')?.textContent ?? ''`);
    if (expectedSuffix === null) {
      if (deviceText.includes(' GB')) {
        throw new UiVerifyFailure(`the boot waiver prompt names '${deviceText}' (arc-igpu has no VRAM - expected the plain name, no suffix)`);
      }
    } else if (!deviceText.includes(expectedSuffix)) {
      throw new UiVerifyFailure(`the boot waiver prompt names '${deviceText}' (expected the VRAM-suffixed name containing '${expectedSuffix}')`);
    }
    return deviceText;
  };
  if (persisted) {
    // M4-D (PERMANENT acceptance): the boot prompt must NOT appear at all.
    // The accepted store never asks again - the accepted-state reminder
    // dialog is REMOVED. Wait for the boot sequence to land (the dashboard
    // GPU Status card renders only after caps arrive - the point where a
    // (buggy) boot prompt would have shown), then assert no modal. The
    // WAIVER_LOST overlay changes nothing: the boot probe RESTORED the
    // driver waiver for the accepted store (the consent stands), so the
    // session boots silent and waiver-get reads accepted.
    if (!(await waitFor(win, `document.querySelectorAll('.health-card').length === 1`, 15000))) {
      throw new UiVerifyFailure(`M4-D: the persisted-accepted session did not land the dashboard health card: page='${(await js(`(document.getElementById('page')?.textContent ?? '').slice(0, 200)`))}'`);
    }
    await sleep(600);
    if (await js(`!!document.querySelector('.modal')`)) {
      throw new UiVerifyFailure(`M4-D: the boot waiver prompt appeared in a PERSISTED-ACCEPTED session (${persisted ? 'RID_MOCK_WAIVER_PERSISTED=1' : ''}${waiverLost ? ' + RID_MOCK_WAIVER_LOST=1' : ''}) - a persisted acceptance skips the boot prompt entirely; page='${(await js(`(document.getElementById('page')?.textContent ?? '').slice(0, 200)`))}'`);
    }
    if (waiverLost) {
      // M4-D pin: the boot probe RESTORED the driver waiver - the backend
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
 *   store (mock sessions use the ISOLATED data dir - the persisted-state
 *   checks must read THIS store, never a default-dir store that would read
 *   the real %APPDATA%\ArcPower settings.json)
 * @param {() => number} [getTrayRebuilds] dev probe: tray-rebuild invocations
 * @param {() => number} [getFpsPolls] dev probe: fps-poll invocations (M2b
 *   review F4 - asserts the Monitoring poll stops on navigation away)
 * @param {() => { minimize: number, maximizeToggle: number, close: number }} [getWindowOpCounts]
 *   M4-D dev probe: the injected window-op counters (ui-verify mode counts
 *   instead of performing the real BrowserWindow ops) - run 2 pins the
 *   integrated title-bar buttons through this.
 */
export async function runUiVerify(win, backend, store, getTrayRebuilds = () => 0, getFpsPolls = () => 0, getWindowOpCounts = () => ({ minimize: 0, maximizeToggle: 0, close: 0 }), getOpenExternalCount = () => 0, getTrayProbe = () => ({ builds: 0, toggleHandler: null, applyHandler: null, doubleClickHandler: null })) {
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
  // M4-D2 (§7/§8): the old Overclocking + Fan pages are the Tuning page now.
  // Navigating to '#/tuning' renders the TUNING sub-view by default, but the
  // view is module-level page state - a prior '#/fan' visit leaves it on the
  // fan sub-view, so every '#/tuning' navigation below also CLICKS the
  // 'Tuning' view pill (idempotent when already active). Fan content uses
  // '#/fan' - the router redirect forces the fan sub-view.
  const gotoView = async (viewLabel) => {
    await js(`(() => {
      const b = Array.from(document.querySelectorAll('.tuning-view-btn')).find((x) => x.textContent.trim() === '${viewLabel}');
      if (b && !b.classList.contains('active')) { b.click(); return true; }
      return false;
    })()`);
    await sleep(250);
  };
  const gotoOverclocking = async () => {
    await js(`location.hash = '#/tuning'`);
    await sleep(250);
    await gotoView('Tuning');
  };

  // --- 0. M4J (G): the tray-start probe (RID_MOCK_START_MINIMIZED=1) ------
  // Start minimized -> the TRAY: the window is created HIDDEN (show:false -
  // tray-only, no taskbar entry, no minimize race) when the persisted
  // setting is on; the tray exists BEFORE the window (S2). The probe:
  // (a) the block runs in ui-verify under the knob, (b) the knob seeded
  // startMinimized:true, (c) the injected tray probe recorded the
  // Show/Hide toggle handler, (d) 'a tray click shows it' is asserted HERE
  // - the very first pin - so the verify drives a VISIBLE window after.
  if (process.env.RID_MOCK_START_MINIMIZED === '1') {
    if (win.isVisible()) {
      fail('M4J (G): RID_MOCK_START_MINIMIZED=1 - the window must start HIDDEN (tray-only, show:false)');
    }
    const probe = getTrayProbe();
    if (probe.builds < 1) {
      fail('M4J (G): the injected tray probe never built the menu (setupTray must run BEFORE createWindow)');
    }
    if (typeof probe.toggleHandler !== 'function') {
      fail('M4J (G): the tray probe did not record the Show/Hide toggle handler');
    }
    // 'a tray click shows it': invoke the RECORDED toggle handler (the real
    // hidden->show branch - win.show() + focus()).
    probe.toggleHandler();
    await sleep(400);
    if (!win.isVisible()) fail('M4J (G): a tray toggle click did not show the hidden window');
    step('m4j-tray-start', `M4J (G): start-minimized session - window created HIDDEN (tray-only, show:false), the tray existed BEFORE the window (menu builds ${probe.builds}), a tray click (recorded toggle handler) showed it (isVisible() true)`);
  } else {
    step('m4j-tray-start', 'M4J (G): tray-start probe SKIPPED (RID_MOCK_START_MINIMIZED not set - the window opens normally)');
  }

  // --- 0b. M17e: the tray DOUBLE-CLICK opens the app (every variant) ------
  // The user's request: double-clicking the tray icon shows/focuses the
  // main window (the same show-window action the menu toggle's show branch
  // performs). The pin: (a) the injected tray probe recorded the
  // 'double-click' handler (setupTray wired tray.on('double-click') - the
  // probe's .on records it), (b) firing it on a HIDDEN window shows it
  // (the real show path - restore-if-minimized + show + focus), (c) the
  // left-click single-click behavior is untouched (the toggle handler
  // above is a separate recorded handler).
  {
    const probe = getTrayProbe();
    if (typeof probe.doubleClickHandler !== 'function') {
      fail('M17e: the tray probe did not record the double-click handler (setupTray must wire tray.on(\'double-click\') to the show-window action)');
    }
    win.hide();
    await sleep(200);
    if (win.isVisible()) fail('M17e: the window did not hide before the double-click probe');
    probe.doubleClickHandler();
    await sleep(400);
    if (!win.isVisible()) fail('M17e: a tray double-click did not show the hidden window (the show-window path must fire)');
    step('m17e-tray-dblclick', `M17e: the tray 'double-click' handler is wired (recorded ${typeof probe.doubleClickHandler === 'function' ? 'function' : 'none'}) + firing it on the hidden window restored it (isVisible() true) - the single-click toggle stays the menu's`);
  }

  // --- 1. shell renders -----------------------------------------------------
  // M4-D2 (§7): 6 nav links - the Overclocking + Fan pages merged into one
  // Tuning page. M6: 7 nav links - the Overlay Settings page (#/overlay)
  // joined the sidebar. M8: 8 nav links - the Graphics tab (#/graphics)
  // joined below Tuning. M9: 7 again - the Overlay Settings content moved
  // INTO the Monitoring page's Overlay view (the Overlay tab is gone).
  if (!(await waitFor(win, `document.querySelectorAll('.sidebar-link').length === 7`))) {
    fail('sidebar did not render (7 nav links expected - Overclocking + Fan merged into Tuning, the Graphics tab added in M8, the Overlay tab removed in M9)');
  }
  const brand = await js(`document.querySelector('.sidebar-brand')?.textContent ?? ''`);
  if (!brand.trim().includes('Arc Power')) fail(`sidebar brand is '${brand}'`);
  // M3-A: the logo IMAGE is gone - the preferred variant is the text
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

  // M4-D: the integrated title bar (frameless window).
  // The title bar spans the top of the window: the left drag zone, the
  // brand CENTERED (logo + 'Arc Power' with the blue gradient 'Power'),
  // the three window controls in the right cluster. The buttons are wired
  // to the injected window ops (getWindowOpCounts - ui-verify counts
  // instead of performing real minimize/close mid-verify); the max
  // button's icon follows the pushed window:maximized-changed state.
  if (!(await waitFor(win, `!!document.querySelector('#titlebar .titlebar-logo')`))) {
    fail('M4-D: the integrated title bar logo did not render');
  }
  const logo = await js(`document.querySelector('#titlebar .titlebar-logo')?.getAttribute('src') ?? ''`);
  if (!logo.includes('icon.png')) fail(`M4-D: the title bar logo src is '${logo}' (expected the assets/icon.png brand mark)`);
  const brandName = await js(`document.querySelector('#titlebar .titlebar-brand-name')?.textContent ?? ''`);
  if (brandName.trim() !== 'Arc Power') fail(`M4-D: the title bar brand name is '${brandName}' (expected 'Arc Power')`);
  // The brand must be CENTERED in the title bar ("move the Arc Power
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
  // blue linear-gradient + glow - the name renders as the brand mark.
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
  // The max button icon follows the pushed window:maximized-changed state.
  // M4J (F): ONE svg - the two inner groups are class-toggled (the svg's
  // icon-state-restore class + the groups' computed display; the pre-M4J
  // two-svg hidden-attribute shape is pinned ABSENT).
  const maxIconState = () => js(`(() => {
    const b = document.querySelector('#titlebar .window-btn[data-op="maximize-toggle"]');
    const svg = b?.querySelector('.icon-maximize-restore');
    if (!svg) return JSON.stringify({ noSvg: true });
    const restoreGroup = svg.querySelector('.icon-restore');
    const maximizeGroup = svg.querySelector('.icon-maximize');
    const restoreVisible = !!restoreGroup && getComputedStyle(restoreGroup).display !== 'none';
    const maxVisible = !!maximizeGroup && getComputedStyle(maximizeGroup).display !== 'none';
    return JSON.stringify({
      nestedSvgCount: svg.querySelectorAll('svg').length,
      stateClass: svg.classList.contains('icon-state-restore'),
      restoreVisible,
      maxVisible,
    });
  })()`);
  win.webContents.send('window:maximized-changed', { maximized: true });
  await sleep(300);
  let iconState = JSON.parse(await maxIconState());
  if (iconState.noSvg || iconState.nestedSvgCount !== 0) {
    fail(`M4J (F): the max button must hold ONE svg (got nested svg count ${iconState.nestedSvgCount}): ${JSON.stringify(iconState)}`);
  }
  if (!iconState.stateClass || !iconState.restoreVisible || iconState.maxVisible) {
    fail(`M4J (F): the max button did not flip to the RESTORE icon on window:maximized-changed {maximized:true} (class ${iconState.stateClass}, restore visible ${iconState.restoreVisible}, maximize visible ${iconState.maxVisible}): ${JSON.stringify(iconState)}`);
  }
  win.webContents.send('window:maximized-changed', { maximized: false });
  await sleep(300);
  iconState = JSON.parse(await maxIconState());
  if (iconState.stateClass || !iconState.maxVisible || iconState.restoreVisible) {
    fail(`M4J (F): the max button did not flip back to the MAXIMIZE icon (class ${iconState.stateClass}, restore visible ${iconState.restoreVisible}, maximize visible ${iconState.maxVisible}): ${JSON.stringify(iconState)}`);
  }
  // Clicking each button performs the injected window op (the counters
  // tick - the real ops would minimize/close the verify window).
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
  // M4-D: the app icon ALSO sits at the title bar's top-LEFT corner,
  // and the max/restore icons are exactly one glyph each (the restore glyph
  // is TWO overlapping squares drawn as one icon - a filled front square
  // over the back outline; the pin asserts the fill so it no longer reads
  // as two separate icons).
  const cornerIcon = await js(`document.querySelector('#titlebar .titlebar-corner-icon')?.getAttribute('src') ?? ''`);
  if (!cornerIcon.includes('icon.png')) fail(`M4-D: the title bar corner icon is '${cornerIcon}' (expected the app icon at the top-left)`);
  // M4-H (D2 - N10)/M4J (F): the restore glyph is TWO rects selected
  // EXPLICITLY (by class - the old single-rect selector would silently pass
  // any layout). The corrected WINDOWS shape: the HOLLOW back square at the
  // TOP-LEFT (1.5,1.5) and the FILLED front square at the BOTTOM-RIGHT
  // (3.5,3.5), the front fill resolving from the .icon-restore-front class
  // to the titlebar background color (--bg-elev). ONE svg element holds
  // both groups (M4J).
  const restoreGlyph = await js(`(() => {
    const svg = document.querySelector('#titlebar .icon-maximize-restore');
    const back = document.querySelector('#titlebar .icon-restore .icon-restore-back');
    const front = document.querySelector('#titlebar .icon-restore .icon-restore-front');
    if (!svg || !back || !front) return 'no-rects';
    const fill = getComputedStyle(front).fill;
    // The titlebar's background resolves var(--bg-elev) to the same rgb
    // form the fill computes to.
    const bg = getComputedStyle(document.querySelector('#titlebar')).backgroundColor;
    return JSON.stringify({
      back: [back.getAttribute('x'), back.getAttribute('y')],
      front: [front.getAttribute('x'), front.getAttribute('y')],
      fill,
      bg,
    });
  })()`);
  const glyph = JSON.parse(restoreGlyph);
  if (glyph === 'no-rects') fail(`M4-H: the restore glyph rects are missing: ${restoreGlyph}`);
  if (glyph.back[0] !== '1.5' || glyph.back[1] !== '1.5') fail(`M4-H: the restore BACK square is at (${glyph.back}) (expected the hollow back at TOP-LEFT 1.5,1.5)`);
  if (glyph.front[0] !== '3.5' || glyph.front[1] !== '3.5') fail(`M4-H: the restore FRONT square is at (${glyph.front}) (expected the filled front at BOTTOM-RIGHT 3.5,3.5)`);
  if (glyph.fill !== glyph.bg) fail(`M4-H: the restore front fill is '${glyph.fill}' (expected the resolved --bg-elev '${glyph.bg}' via .icon-restore-front)`);
  const tbRect = await js(`(() => { const b = document.querySelector('#titlebar .icon-maximize-restore'); const r = b.getBoundingClientRect(); return JSON.stringify({ w: r.width, h: r.height }); })()`);
  step('titlebar-extras', `top-left corner icon OK; restore glyph is ONE icon in ONE svg (M4-H: hollow back at 1.5,1.5 + filled front at 3.5,3.5 with the class fill '${glyph.fill}', ${JSON.parse(tbRect).w}x${JSON.parse(tbRect).h}px; the two groups class-swap by state)`);

  // M4-D: the sidebar - per-tab icons left of the names, the brand
  // "Power" illuminated like the title bar, the brand BOLD.
  const sidebarIcons = await js(`Array.from(document.querySelectorAll('.sidebar-link')).map((l) => ({ label: l.querySelector('.sidebar-link-label')?.textContent, hasIcon: !!l.querySelector('.sidebar-icon') }))`);
  if (!sidebarIcons.every((i) => i.hasIcon === true && i.label)) fail(`M4-D: every sidebar link must carry an icon + label: ${JSON.stringify(sidebarIcons)}`);
  if (sidebarIcons.length !== 7) fail(`M9: expected 7 sidebar links with icons (the Overlay tab moved into the Monitoring page in M9 - the Graphics tab joined in M8), got ${sidebarIcons.length}`);
  // M8: the Graphics tab sits DIRECTLY BELOW Tuning in the sidebar DOM (the
  // planned order: dashboard / tuning / graphics / monitoring / ...).
  const navOrder = await js(`JSON.stringify(Array.from(document.querySelectorAll('.sidebar-nav .sidebar-link-label')).map((l) => (l.textContent ?? '').trim()))`);
  const navLabels = JSON.parse(navOrder);
  const graphicsIdx = navLabels.indexOf('Graphics');
  const tuningIdx = navLabels.indexOf('Tuning');
  if (graphicsIdx < 0 || graphicsIdx !== tuningIdx + 1) {
    fail(`M8: the Graphics tab must sit DIRECTLY BELOW Tuning in the sidebar (nav order '${navOrder}')`);
  }
  step('m8-nav-position', `M8: the sidebar nav order is ${navOrder} - the Graphics tab sits directly below Tuning`);
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

  // --- M4-H (D1): the sidebar GitHub footer + the open-external channel ----
  // The footer link (GitHub icon + 'GitHub') sits at the BOTTOM-LEFT of the
  // sidebar (margin-top:auto below the nav); clicking it invokes the NEW
  // 'open-external' IPC channel (an INJECTED op - the counting probe in
  // ui-verify mode). The channel STRICTLY validates (S3): new URL() +
  // protocol https: + hostname github.com + the '/YamsSE/Arc-Power' path
  // (exact or a '/YamsSE/Arc-Power/' prefix) - anything else rejects and
  // never opens.
  if (!(await waitFor(win, `!!document.querySelector('.sidebar-footer-link')`, 5000))) {
    fail('M4-H: the sidebar GitHub footer link is missing');
  }
  const ghLabel = await js(`document.querySelector('.sidebar-footer-link .sidebar-footer-label')?.textContent ?? ''`);
  if (ghLabel.trim() !== 'GitHub') fail(`M4-H: the footer label is '${ghLabel}' (expected 'GitHub')`);
  if (!(await js(`!!document.querySelector('.sidebar-footer-link .sidebar-icon-github')`))) fail('M4-H: the footer GitHub icon is missing');
  const ghBelowNav = await js(`(() => {
    const footer = document.querySelector('.sidebar-footer');
    const nav = document.querySelector('.sidebar-nav');
    if (!footer || !nav) return false;
    return footer.getBoundingClientRect().top >= nav.getBoundingClientRect().bottom - 1;
  })()`);
  if (!ghBelowNav) fail('M4-H: the GitHub footer is not below the sidebar nav (bottom-left)');
  const ghOpBefore = getOpenExternalCount();
  await js(`document.querySelector('.sidebar-footer-link').click()`);
  await sleep(300);
  if (getOpenExternalCount() !== ghOpBefore + 1) {
    fail('M4-H: clicking the GitHub link did not tick the open-external counter');
  }
  const openOk = await js(`(async () => { try { await window.arcPower.openExternal('https://github.com/YamsSE/Arc-Power'); return 'ok'; } catch (e) { return 'rejected:' + e.message; } })()`);
  if (openOk !== 'ok') fail(`M4-H: the canonical repo URL was rejected: ${openOk}`);
  const badUrls = [
    'https://evil.example/YamsSE/Arc-Power',
    'https://github.com.evil.example/YamsSE/Arc-Power',
    'https://github.com@evil.example/YamsSE/Arc-Power',
    'https://github.com/OtherOrg/Arc-Power',
    'http://github.com/YamsSE/Arc-Power',
    'https://github.com/YamsSE/',
    'https://github.com/YamsSE/Arc-PowerX',
    'not a url',
    '',
  ];
  for (const bad of badUrls) {
    const r = await js(`(async () => { try { await window.arcPower.openExternal(${JSON.stringify(bad)}); return 'accepted'; } catch (e) { return 'rejected'; } })()`);
    if (r !== 'rejected') fail(`M4-H: open-external ACCEPTED '${bad}' (must reject)`);
  }
  const ghOpAfter = getOpenExternalCount();
  step('m4h-github-footer', `M4-H: sidebar GitHub footer (icon + 'GitHub', bottom-left) -> open-external counter ticked (${ghOpBefore} -> ${ghOpAfter}); channel validation: repo URL ok, ${badUrls.length} bad URLs rejected`);

  // M7b (amendment): the Settings tab sits in the sidebar FOOTER -
  // bottom-RIGHT (the GitHub-page mirror: GitHub bottom-left, Settings
  // bottom-right = the window's bottom-right corner). The link KEEPS the
  // .sidebar-link class (the icon + the label + the active state + the
  // href) but lives INSIDE .sidebar-footer, NOT .sidebar-nav; the footer
  // row is a flex row with justify-content: space-between; clicking the
  // link lands on #/settings. The count pins above (7 .sidebar-link
  // GLOBALLY - 6 nav + 1 footer) stay green by design.
  const settingsFooter = await js(`(() => {
    const footer = document.querySelector('.sidebar-footer');
    const link = footer ? footer.querySelector('.sidebar-link[href="#/settings"]') : null;
    return JSON.stringify({
      inFooter: !!link,
      inNav: !!document.querySelector('.sidebar-nav .sidebar-link[href="#/settings"]'),
      href: link?.getAttribute('href') ?? null,
      hasIcon: !!link?.querySelector('.sidebar-icon'),
      hasLabel: !!link?.querySelector('.sidebar-link-label'),
      label: link?.querySelector('.sidebar-link-label')?.textContent ?? null,
      justify: footer ? getComputedStyle(footer).justifyContent : null,
    });
  })()`);
  const sfl = JSON.parse(settingsFooter);
  if (!sfl.inFooter || sfl.inNav) {
    fail(`M7b: the Settings link must live in .sidebar-footer (NOT .sidebar-nav): ${settingsFooter}`);
  }
  if (sfl.href !== '#/settings') fail(`M7b: the footer Settings link href is '${sfl.href}' (expected '#/settings')`);
  if (!sfl.hasIcon || !sfl.hasLabel || sfl.label !== 'Settings') {
    fail(`M7b: the footer Settings link must keep the .sidebar-link icon + label (got ${settingsFooter})`);
  }
  if (sfl.justify !== 'space-between') {
    fail(`M7b: the footer row's computed justify-content is '${sfl.justify}' (expected 'space-between' - GitHub left, Settings right)`);
  }
  await js(`document.querySelector('.sidebar-footer .sidebar-link[href="#/settings"]').click()`);
  if (!(await waitFor(win, `location.hash === '#/settings'`, 5000))) {
    fail(`M7b: clicking the footer Settings link did not land on '#/settings' (hash '${await js(`location.hash`)}')`);
  }
  // The active state follows the link (the .sidebar-link active styling).
  if (!(await waitFor(win, `document.querySelector('.sidebar-footer .sidebar-link[href="#/settings"]')?.classList.contains('active')`, 5000))) {
    fail('M7b: the footer Settings link is not active on #/settings');
  }
  // Restore the dashboard - the flow below pins the dashboard cards.
  await js(`location.hash = '#/dashboard'`);
  if (!(await waitFor(win, `!!document.querySelector('.card-grid .device-card')`, 8000))) {
    fail('M7b: the dashboard did not re-render after the settings-footer placement pin');
  }
  step('m7b-settings-footer', `M7b: the Settings link lives in .sidebar-footer (not .sidebar-nav), keeps the icon + 'Settings' label + href '#/settings' + the active state, the footer row is 'space-between' (GitHub bottom-left / Settings bottom-right); clicking it landed on #/settings and back`);

  // M4-A/M4-B: the shared waiver boot-step - the boot prompt appears in
  // EVERY session: cancelled in the unaccepted sessions (Cancel here;
  // Accept under RID_MOCK_WAIVER_BOOT_ACCEPT=1), or shown in its ACCEPTED
  // state under RID_MOCK_WAIVER_PERSISTED=1 (reminder with a single OK).
  const bootAcceptedAtBoot = await bootWaiverStep(win, js, waitFor);
  step('waiver-boot', process.env.RID_MOCK_WAIVER_PERSISTED === '1'
    ? (process.env.RID_MOCK_WAIVER_LOST === '1'
      ? 'persisted store said accepted but the DRIVER lost the waiver: the boot probe RESTORED the driver waiver - boot prompt SKIPPED (permanent acceptance), waiver-get accepted'
      : 'persisted acceptance at boot: boot prompt SKIPPED entirely (permanent acceptance - the accepted-state reminder dialog is removed)')
    : `boot waiver prompt handled: ${bootAcceptedAtBoot ? 'Accepted (no dialog anywhere after)' : 'Cancelled (first apply re-shows the dialog)'}`);

  // --- waiver gate seed state (used by every waiver-flow section below) ----
  // M3-C review F4: the persisted state read must use the SESSION store - a
  // default-dir ProfileStore would read the REAL settings.json while the
  // mock session reads/writes its isolated dir (the check would always see
  // a mismatch). bootAccepted is the device-side flag (waiver-get) - the
  // source the renderer's health row reads.
  const persistedWaiver = (await store.loadSettings()).waiverAccepted === true;
  const bootAccepted = (await js(`window.arcPower.waiverGet(0)`)).accepted === true;
  if (persistedWaiver && !bootAccepted) {
    fail('boot did not seed the persisted waiver acceptance (settings.json says accepted)');
  }
  step('waiver-seed', `boot waiver state: store=${persistedWaiver ? 'accepted' : 'not accepted'}, backend=${bootAccepted ? 'accepted' : 'not accepted'}`);

  // M4J clarification: whether THIS session's device carries vramFreqOffset
  // - the key for the ADVANCED SECTION ONLY (the pure advancedUiVisible
  // contract; b580 = the VRAM clock editor, a770/arc-igpu/pro-b50 = no
  // section). The OC-mode column (Stock/Advanced pill) is NOT keyed on it -
  // the pill renders on EVERY device as in 1.0.3.
  const vramFreqUi = (await backend.getCapabilities(0)).controls?.vramFreqOffset === true;
  step('m4j-vramfreq-ui', `M4J (D): this session's device ${vramFreqUi ? 'carries' : 'LACKS'} vramFreqOffset - the Advanced SECTION ${vramFreqUi ? 'renders (the VRAM clock editor)' : 'is GONE (Alchemist - only the bottom expert section is removed; the OC-mode pill stays)'}`);
  // M17d (Run D)/M17e (Run B): whether THIS session's device carries the
  // gpuLock control - the key for the nested gpuLock editor + the Offset|Lock
  // toggle on the freq card (a770/a750/acer-a750 yes; b580/arc-igpu/pro-b50
  // no - the offset-only card).
  const gpuLockUi = (await backend.getCapabilities(0)).controls?.gpuLock === true;
  step('m17d-gpulock-ui', `M17d/M17e: this session's device ${gpuLockUi ? 'carries' : 'LACKS'} gpuLock - the Offset|Lock toggle + the nested lock editor ${gpuLockUi ? 'render' : 'are absent (offset-only card)'}`);

  // --- 1b. M2C-B B3 header version line + B2/B8 dashboard GPU card ------
  // B3: the line below the GPU name is the APP version (app:version IPC) -
  // the driver line lives in the dashboard GPU Status card (the GPU card's
  // Driver version row is REMOVED - M4-H). M8: the 1.1.0 base bump changed
  // the display form; M9: the 1.1.1 base bump (displayVersion strips the
  // -beta.x tag of a prerelease version and appends ' Alpha' to a bare
  // semver - the OLD scheme). M11: the version is the 1.0 RELEASE and the
  // "Alpha" naming scheme is gone - the display is the plain
  // 'Arc Power Ver. 1.0.0'. M17e (round-2 N1): the 1.0.1 bump - the pinned
  // text is EXACTLY 'Arc Power Ver. 1.0.1' (NO Beta; the suffix logic
  // keeps the Beta line only for -beta.x versions).
if (!(await waitFor(win, `(document.querySelector('.gpu-meta')?.textContent ?? '').trim() === 'Arc Power Ver. 1.0.1'`))) {
fail(`header version line is '${await js(`document.querySelector('.gpu-meta')?.textContent ?? ''`)}' (expected 'Arc Power Ver. 1.0.1')`);
  }
  // B6: the page favicon points at the generated blue-AP asset.
  const favicon = await js(`document.querySelector('link[rel="icon"]')?.getAttribute('href') ?? ''`);
  if (!favicon.includes('favicon.png')) fail(`favicon link is '${favicon}'`);
  // M4-D: the pin must catch the old PCI-ID text ('PCI\VEN...'), not
  // the word 'PCI'. M4-D2 (§2): the PCIe ROW is gone (the unpopulated 1/1
  // kernel pattern made it a permanent '-') - the body must not contain the
  // 'PCIe' row either.
  if (await js(`document.body.textContent.includes('PCI\\\\')`)) fail('PCI ID is still shown somewhere in the UI');
  if (await js(`document.querySelector('.card-grid .kv[data-label="PCIe"]')`)) fail('M4-D2: the PCIe kv row is still rendered (the row was removed)');
  // M3-A: the header status indicator is REMOVED - no dot, no 'Service
  // Status' label anywhere (IGS is no longer a status item).
  if (await js(`!!document.querySelector('.gpu-header .status-dot')`)) fail('M3-A: the header still renders a status dot');
  if (await js(`document.body.textContent.includes('Service Status')`)) fail('M3-A: "Service Status" is still rendered somewhere');
  if (await js(`document.body.textContent.includes('IGS')`)) fail('M3-A: IGS is still surfaced as a status item');
  step('version-line', `header line '${await js(`document.querySelector('.gpu-meta')?.textContent ?? ''`)}'; no PCI text; no status dot / Service Status label`);
  // --- 1.0.1 Themes (M3): the persisted theme applies at BOOT --------------
  // The attribute lives on <html> (documentElement.dataset.theme), written
  // by the boot sequence right after health + the hoisted profiles envelope
  // read. The default session boots on Dark Steel (the M2 mock seed);
  // RID_MOCK_THEME=light flips the seed for the light-boot sanity run. The
  // COMPUTED --bg assertion pins the equal-specificity ordering hazard (the
  // [data-theme] blocks must win over :root).
  const bootTheme = process.env.RID_MOCK_THEME === 'light' ? 'light' : 'dark';
  const bootBg = bootTheme === 'light' ? '#f2f4f8' : '#0f1116';
  if (!(await waitFor(win, `document.documentElement.dataset.theme === '${bootTheme}'`, 8000))) {
    fail(`1.0.1: the boot theme attribute is '${await js(`document.documentElement.dataset.theme ?? ''`)}' (expected '${bootTheme}')`);
  }
  if (!(await waitFor(win, `getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() === '${bootBg}'`, 8000))) {
    fail(`1.0.1: the boot computed --bg is '${await js(`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`)}' (expected '${bootBg}')`);
  }
  step('themes-boot', `1.0.1: boot theme '${bootTheme}' on <html> + computed --bg ${bootBg} (applied from the persisted envelope, equal-specificity ordering safe)`);

  // M17c (user request): the shared --control-bg token renders on the
  // interactive controls - the M8-style computed-style pins for a select
  // (.featureset-select - always present in mock mode), a plain non-primary
  // .btn (the Tweaks Refresh button - the only non-ghost/non-primary .btn
  // in the app) and a checkbox (.settings-checkbox) in BOTH themes (the
  // Settings theme chips flip the session; the dark state is restored for
  // the later pins).
  const expectControlBg = async (sel, theme) => {
    const bg = await js(`getComputedStyle(document.querySelector('${sel}')).backgroundColor`);
    const want = theme === 'light' ? 'rgb(220, 226, 234)' : 'rgb(10, 13, 19)';
    if (bg !== want) {
      fail(`M17c: the computed background of ${sel} is '${bg}' (expected the --control-bg token '${want}' in the ${theme} theme)`);
    }
  };
  const clickThemeChip = (theme) => js(`(() => { const b = Array.from(document.querySelectorAll('button.theme-option')).find((x) => x.dataset.themeOption === '${theme}'); if (b) b.click(); return !!b; })()`);
  await expectControlBg('.featureset-select', 'dark');
  await js(`location.hash = '#/tweaks'`);
  await sleep(250);
  await expectControlBg('.tweak-refresh', 'dark');
  await js(`location.hash = '#/settings'`);
  await sleep(250);
  await expectControlBg('.settings-checkbox[data-setting="startMinimized"]', 'dark');
  // Flip to light: the theme chip applies + persists immediately.
  if (!(await js(`!!document.querySelector('button.theme-option[data-theme-option="light"]')`))) {
    fail('M17c: the Settings page theme chips are missing');
  }
  await clickThemeChip('light');
  if (!(await waitFor(win, `document.documentElement.dataset.theme === 'light'`, 5000))) {
    fail('M17c: the light theme flip did not land (the theme chip must apply immediately)');
  }
  await expectControlBg('.settings-checkbox[data-setting="startMinimized"]', 'light');
  await js(`location.hash = '#/dashboard'`);
  await sleep(250);
  await expectControlBg('.featureset-select', 'light');
  await js(`location.hash = '#/tweaks'`);
  await sleep(250);
  await expectControlBg('.tweak-refresh', 'light');
  // Restore the dark session (the later pins expect the boot theme).
  await js(`location.hash = '#/settings'`);
  await sleep(250);
  await clickThemeChip('dark');
  if (!(await waitFor(win, `document.documentElement.dataset.theme === 'dark'`, 5000))) {
    fail('M17c: the dark theme restore did not land');
  }
  await js(`location.hash = '#/dashboard'`);
  await sleep(250);
  step('m17c-control-bg', 'M17c: the --control-bg token renders on a select + a plain .btn + a checkbox in BOTH themes (the dark/light computed-style pins)');

  // M4-H (C1): the GPU card - title 'GPU', the device name in a 'GPU' kv
  // row under it (the CPU-card layout mirrored: title, then the 'CPU' kv
  // row - the GPU card mirrors that with a 'GPU' row), NO Driver version
  // row anywhere in the card (the health card keeps it - pinned below),
  // Compute + Clocks + the standalone ReBAR pill stay.
  if (!(await waitFor(win, `(() => {
    const card = document.querySelector('.card-grid .device-card');
    if (!card) return false;
    const title = card.querySelector('.card-title')?.textContent ?? '';
    const gpuKv = Array.from(card.querySelectorAll('.kv')).find((k) => (k.getAttribute('data-label') ?? '') === 'GPU');
    return title.trim() === 'GPU' && !!gpuKv && (gpuKv.textContent ?? '').trim().length > 0;
  })()`, 8000))) {
    fail(`M4-H: the GPU card layout is wrong (title '${await js(`document.querySelector('.device-card .card-title')?.textContent ?? ''`)}', GPU kv '${await js(`document.querySelector('.card-grid .device-card .kv[data-label="GPU"]')?.textContent ?? ''`)}')`);
  }
  if (await js(`!!document.querySelector('.card-grid .kv[data-label="Driver version"]')`)) {
    fail('M4-H: the GPU card still renders the Driver version row (removed - the health card keeps it)');
  }
  const gpuNameKv = await js(`document.querySelector('.card-grid .device-card .kv[data-label="GPU"]')?.textContent ?? ''`);
  if (!(await waitFor(win, `document.body.textContent.includes('Xe Cores 32 - Shader Units 4096')`))) {
    fail('Xe cores / shader units line missing');
  }
  // M17c/M17d: the Board partner row BELOW the Device row - '<AIB vendor>
  // (<model>)' from the caps AIB fields (the a770 mock's 0x1849/0x6001
  // pairing decodes ASRock / Phantom Gaming - M17d FLIP: the model drops
  // the trailing VRAM-amount token, the user's exact request).
  if (!(await waitFor(win, `(() => {
    const card = document.querySelector('.card-grid .device-card');
    const kvs = Array.from(card?.querySelectorAll('.kv') ?? []);
    const gpuIdx = kvs.findIndex((k) => (k.getAttribute('data-label') ?? '') === 'GPU');
    const aibIdx = kvs.findIndex((k) => (k.getAttribute('data-label') ?? '') === 'Board partner');
    const aibRow = kvs[aibIdx];
    return aibIdx === gpuIdx + 1 && !!aibRow && (aibRow.textContent ?? '').trim() === 'ASRock (Phantom Gaming)';
  })()`, 5000))) {
    fail(`M17c: the Board partner row is '${await js(`document.querySelector('.card-grid .device-card .kv[data-label="Board partner"]')?.textContent ?? ''`)}' (expected 'ASRock (Phantom Gaming)' directly below the Device row)`);
  }
  step('m17c-board-partner', 'M17c/M17d: the Board partner row renders directly below the Device row - ASRock (Phantom Gaming) (the 0x1849/0x6001 decode, the VRAM amount stripped)');
  // The waiver status row lives in the HEALTH card (below), not on the
  // device card: no 'OC waiver' text in any device-card kv row.
  if (await js(`Array.from(document.querySelectorAll('.card-grid .kv')).some((k) => (k.textContent ?? '').includes('OC waiver'))`)) fail('M4-A: the device card still shows the waiver status (the row lives in the GPU Status card)');
  // B2: the chips footer ("Fan curve N points", power/volt/freq/temp notes)
  // is GONE from the device card - no chips inside the card grid EXCEPT the
  // M4-D ReBAR pill (a deliberate new chip, excluded here).
  const gridChips = await js(`document.querySelectorAll('.card-grid .chip:not(.rebar-pill)').length`);
  if (gridChips !== 0) fail(`B2: device card chips footer still renders ${gridChips} chips`);
  step('device-card', 'device card: Xe Cores 32 - Shader Units 4096, no PCI row, no chips footer (ReBAR pill is the only chip)');

  // M4-I (B2): the VRAM row below the Shader info - the same ceil contract
  // as formatDeviceName with the memType CARRIED ON THE DEVICE PAYLOAD
  // (the mock fixture supplies 'GDDR6'; the header/card/selector/waiver all
  // read the SAME device.name - one format everywhere, no renderer-side
  // composition).
  if (!(await waitFor(win, `(() => {
    const row = Array.from(document.querySelectorAll('.card-grid .device-card .kv'))
      .find((k) => (k.getAttribute('data-label') ?? '') === 'VRAM');
    return row && (row.textContent ?? '').trim() === '16GB GDDR6';
  })()`, 5000))) {
    fail(`M4-I: the device-card VRAM row is '${await js(`document.querySelector('.card-grid .device-card .kv[data-label="VRAM"]')?.textContent ?? ''`)}' (expected '16GB GDDR6' - ceil GiB + the payload memType)`);
  }
  step('m4i-vram-row', 'M4-I (B2): the device card renders the VRAM row (16GB GDDR6 - ceil + the payload-carried memType)');

  // M4-D: the core + memory clock BUNDLED row ("… MHz Core /
  // 2187 MHz Memory" - a770 featureset telemetry memClockMhz = 2187).
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
  // M4-H (C3): the readout is TWO labeled groups - the GPU tiles live in
  // the GPU group container (tile lookups SCOPED to the group - N8).
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('#dash-readout-gpu .stat-tile')).some((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'Memory clock' && (t.querySelector('.stat-value')?.textContent ?? '') === '2187')`))) {
    fail('memory-clock readout missing or not 2187 MHz');
  }
  step('mem-clock', `memory clock readout = ${await js(`Array.from(document.querySelectorAll('#dash-readout-gpu .stat-tile')).find((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'Memory clock')?.querySelector('.stat-value')?.textContent ?? ''`)} MHz (compact tiles)`);

  // --- M4-D + M4-D2 (§9): the CPU & memory card (sysinfo:get fixture)
  // The card sits BEFORE the GPU card in the card-grid and renders the mock
  // fixture: CPU name + the BUNDLED cores/threads row (the CLOCK half is
  // LIVE - cpuFreqMhz from the telemetry tick, GHz always - pinned below)
  // + the BUNDLED RAM brand/size/speed rows (chosen formats). Every field
  // degrades to '-' when null (pinned by the pure/sysinfo.ts unit tests;
  // the fixture here is all-populated).
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('.card-grid > .card')).some((c) => (c.querySelector('.card-title')?.textContent ?? '') === 'CPU & Memory')`, 5000))) {
    fail('M4-D: the CPU & Memory card did not render');
  }
  const gridCardTitles = await js(`Array.from(document.querySelectorAll('.card-grid > .card .card-title')).map((t) => t.textContent).join('|')`);
  if (!gridCardTitles.startsWith('CPU & Memory')) {
    fail(`M4-D2 (§9): the CPU & Memory card is not FIRST in the card-grid (before the GPU card): '${gridCardTitles}'`);
  }
  const sysinfoRows = await js(`JSON.stringify(Object.fromEntries(Array.from(document.querySelectorAll('.sysinfo-card .kv')).map((k) => [k.getAttribute('data-label'), (k.textContent ?? '').trim()])))`);
  const sysRows = JSON.parse(sysinfoRows);
  if (sysRows['CPU'] !== 'Intel(R) Core(TM) i7-14700K') fail(`M4-D: CPU row is '${sysRows['CPU']}' (expected the sysinfo fixture name)`);
  // M4-H (C2)/M4J (B)/M4L (A): the Memory row reads "G.Skill 32 GB DDR5 @
  // 6000 MHz" - the SMBIOS type (34 = DDR5) inserted between the size and
  // the speed; the speed half renders in its OWN .kv-static-freq span
  // (blue accent via the shared rule - never the kv-live-freq class
  // itself, N3). M4J made the speed ALWAYS GHz ("@ 6.0 GHz"); M4L
  // INVERTS it back to MHz ("@ 6000 MHz" - the mock's 6000 MHz; the '@ '
  // prefix kept). The inversion is documented like the M4-I driver-row
  // inversion (the pin changed, the feature intent unchanged).
  if (sysRows['Memory'] !== 'G.Skill 32 GB DDR5 @ 6000 MHz') fail(`M4L: Memory row is '${sysRows['Memory']}' (expected 'G.Skill 32 GB DDR5 @ 6000 MHz' - the M4J GHz pin is INVERTED back to MHz)`);
  if (!(await waitFor(win, `(() => {
    const span = document.querySelector('.sysinfo-card .kv[data-label="Memory"] .kv-static-freq');
    if (!span || span.textContent !== '@ 6000 MHz') return false;
    const live = document.querySelector('.sysinfo-card .kv-live-freq');
    if (!live) return false;
    const cs = getComputedStyle(span);
    const liveCs = getComputedStyle(live);
    // The static span SHARES the kv-live-freq rule (same computed color +
    // weight) - it must never BE the kv-live-freq class (the onUpdate
    // first-match hazard - N3).
    return cs.color === liveCs.color && cs.fontWeight === liveCs.fontWeight && !span.classList.contains('kv-live-freq');
  })()`, 5000))) {
    fail(`M4L: the memory speed span is not the blue .kv-static-freq (text '${await js(`document.querySelector('.sysinfo-card .kv[data-label="Memory"] .kv-static-freq')?.textContent ?? ''`)}')`);
  }
  // M4L (A): the F1-grid fix - the Memory row is ONE line. The two spans
  // (the static "G.Skill 32 GB DDR5 " piece + the speed span) sit inside a
  // SINGLE .kv-memory wrapper (the .kv-cores-clock precedent), so the row
  // never wraps and the Mainboard row sits DIRECTLY below (top-to-top, the
  // 6px grid gap allowed). NOTE: the .kv row itself is display:contents
  // (no box - a 0-height rect), so the geometry is measured on the
  // .kv-memory wrapper span (the actual text box).
  const memoryOneLine = await js(`(() => {
    const kv = document.querySelector('.sysinfo-card .kv[data-label="Memory"]');
    const wrapper = kv?.querySelector('.kv-memory');
    const span = kv?.querySelector('.kv-static-freq');
    if (!kv || !wrapper || !span) return 'no-nodes';
    const wRect = wrapper.getBoundingClientRect();
    const spanRect = span.getBoundingClientRect();
    const kvStyle = getComputedStyle(wrapper);
    const lineH = parseFloat(kvStyle.lineHeight) || parseFloat(kvStyle.fontSize) * 1.2;
    const oneLine = Math.abs(wRect.height - lineH) <= 2;
    const noWrap = wrapper.scrollWidth <= wrapper.clientWidth + 2;
    // Same-line semantic: the span's box starts INSIDE the wrapper's single
    // text line (the mono font's inline metrics differ from the row font, so
    // top-to-top would be a false negative). A span dropped to the NEXT row
    // starts >= one line-height below the wrapper's top.
    const sameLine = (spanRect.top - wRect.top) < lineH - 1 && spanRect.bottom > wRect.top;
    const wrapperHasBoth = wrapper.children.length === 2;
    return JSON.stringify({ oneLine, noWrap, sameLine, wrapperHasBoth, h: wRect.height, lineH, spanTop: spanRect.top, wTop: wRect.top });
  })()`);
  if (memoryOneLine === 'no-nodes') fail('M4L: the Memory kv row / .kv-memory wrapper / .kv-static-freq span are missing');
  const memGeo = JSON.parse(memoryOneLine);
  if (!memGeo.wrapperHasBoth) fail('M4L: the .kv-memory wrapper does not contain BOTH spans (the F1-grid fix - expected 2 children)');
  if (!memGeo.oneLine) fail(`M4L: the Memory row is NOT one text line (height ${memGeo.h}px vs line-height ${memGeo.lineH}px)`);
  if (!memGeo.noWrap) fail('M4L: the Memory row wraps (scrollWidth > clientWidth + 2 - the .kv-memory nowrap is missing)');
  if (!memGeo.sameLine) fail('M4L: the speed span is NOT on the same line as the DDR5 flag (the sibling dropped to another row)');
  // M4L (A): the Mainboard row sits DIRECTLY below the Memory row (the F1
  // bug scrambled it: the un-wrapped freq span auto-placed into the next
  // row's label column). The .kv rows are display:contents (no box), so the
  // real text boxes are measured: the Memory row's .kv-memory wrapper vs the
  // Mainboard row's value span. "Directly below" = the Mainboard value
  // starts on the row AFTER the Memory row: its top is >= the Memory row's
  // top + one line (never the same row), and the gap to the Memory row's
  // bottom is within the 6px grid gap (+ 2px tolerance).
  const mainboardBelow = await js(`(() => {
    const mem = document.querySelector('.sysinfo-card .kv[data-label="Memory"] .kv-memory');
    const mb = document.querySelector('.sysinfo-card .kv[data-label="Mainboard"] > span');
    if (!mem || !mb) return 'no-nodes';
    const memRect = mem.getBoundingClientRect();
    const mbRect = mb.getBoundingClientRect();
    const gap = mbRect.top - memRect.bottom;
    const nextRow = mbRect.top >= memRect.top + memRect.height - 1;
    // the 6px grid gap (+ 2px tolerance for the line-height rounding).
    return JSON.stringify({ nextRow, gap: Math.round(gap * 10) / 10, maxGap: 8 });
  })()`);
  if (mainboardBelow === 'no-nodes') fail('M4L: the Mainboard row is missing (the Memory-row wrap check needs it)');
  const mbGeo = JSON.parse(mainboardBelow);
  if (!mbGeo.nextRow) fail(`M4L: the Mainboard row starts ON the Memory row (top diff ${mbGeo.gap}px - the F1 scramble is back)`);
  if (mbGeo.gap > mbGeo.maxGap + 2) fail(`M4L: the Mainboard row is NOT directly below the Memory row (gap ${mbGeo.gap}px - the 6px grid gap allowed)`);
  // M4J (B): the 'Mainboard' row REPLACES the M4-I 'Cache' row - the mock
  // fixture's baseboard renders "ASUSTeK MAXIMUS VII RANGER" (the short-map
  // manufacturer + product). The old Cache/Caches labels must be GONE.
  if (sysRows['Mainboard'] !== 'ASUSTeK MAXIMUS VII RANGER') {
    fail(`M4J: the Mainboard row is '${sysRows['Mainboard']}' (expected 'ASUSTeK MAXIMUS VII RANGER' - short-map + product)`);
  }
  if (sysRows['Cache'] !== undefined || sysRows['Caches'] !== undefined) {
    fail(`M4J: the Cache row is still rendered (removed with the M4-I cache work - got ${Object.keys(sysRows).join(',')})`);
  }
  // M4-I (A3): the label is 'Cores / Clock' (was 'Cores / clock').
  if (sysRows['Cores / Clock'] === undefined || sysRows['Cores / clock'] !== undefined) {
    fail(`M4-I: the cores row data-label is not 'Cores / Clock' (got ${Object.keys(sysRows).join(',')})`);
  }
  // M4-D2 (§6): the LIVE frequency half of the Cores/Clock row - the mock
  // telemetry pushes cpuFreqMhz=4300 -> the row reads "20 Cores / 28
  // Threads / @ 4.3 GHz" (GHz ALWAYS, 1 decimal), updated IN PLACE on
  // ticks (the waitFor also covers the telemetry landing).
  if (!(await waitFor(win, `(document.querySelector('.sysinfo-card .kv[data-label="Cores / Clock"]')?.textContent ?? '').trim() === '20 Cores / 28 Threads / @ 4.3 GHz'`, 8000))) {
    fail(`M4-D2: the Cores / Clock row is '${await js(`document.querySelector('.sysinfo-card .kv[data-label="Cores / Clock"]')?.textContent ?? ''`)}' (expected the static '20 Cores / 28 Threads' + the LIVE '/ @ 4.3 GHz' from the mock cpuFreqMhz 4300)`);
  }
  const liveFreqText = await js(`document.querySelector('.sysinfo-card .kv-live-freq')?.textContent ?? ''`);
  if (liveFreqText !== ' / @ 4.3 GHz') fail(`M4-D2: the live-freq span is '${liveFreqText}' (expected ' / @ 4.3 GHz')`);
  step('m4j-cpu-card', `CPU & Memory card first in the card-grid: '${sysRows['CPU']}', '20 Cores / 28 Threads / @ 4.3 GHz', '${sysRows['Memory']}', Mainboard '${sysRows['Mainboard']}' (Cache row removed)`);

  // --- M4-I (A4): the sysinfo-card and the device-card kv rows start at
  // the SAME vertical position (the CPU card's title margin-box vs the GPU
  // card's head - equalized in CSS).
  const kvTopDiff = await js(`(() => {
    const cpuKv = document.querySelector('.sysinfo-card .card-body');
    const gpuKv = document.querySelector('.device-card .card-body');
    if (!cpuKv || !gpuKv) return 'no-bodies';
    return Math.abs(cpuKv.getBoundingClientRect().top - gpuKv.getBoundingClientRect().top);
  })()`);
  if (kvTopDiff === 'no-bodies' || Number(kvTopDiff) > 1) {
    fail(`M4-I (A4): the CPU-card and GPU-card kv rows do not start at the same y (diff ${kvTopDiff}px - expected <= 1px)`);
  }
  step('m4i-card-align', `M4-I (A4): the sysinfo-card and device-card kv rows start at the same y (diff ${kvTopDiff}px)`);

  // --- M4-H (C3)/M4M (D)/M4N (A): the TWO-GROUP live readout (CPU above
  // GPU) ----------------------------------------------------------------
  // The tile lookups are SCOPED to the group containers (N8 - both groups
  // carry Temperature/Util-like labels). CPU: 4 tiles incl. the Power tile
  // (cpuPowerW 125.5 from the mock PowerMeter fixture; M4N: renamed from
  // Wattage); GPU: 6 tiles (M4N: 'Power' replaces 'Power draw'). M4N: the
  // CPU Core Frequency tile reads the mock's 4300 MHz as '4.3' GHz.
  // M4M (D): Util FIRST in both groups (the order pin).
  const groupLabels = await js(`JSON.stringify(Array.from(document.querySelectorAll('.readout-card .readout-group-label')).map((l) => l.textContent))`);
  if (JSON.parse(groupLabels).join(',') !== 'CPU,GPU') fail(`M4-H: the readout groups are '${groupLabels}' (expected 'CPU','GPU' - CPU ABOVE GPU)`);
  const cpuTiles = await js(`JSON.stringify(Array.from(document.querySelectorAll('#dash-readout-cpu .stat-tile')).map((t) => [(t.querySelector('.stat-label')?.textContent ?? '').trim(), (t.querySelector('.stat-value')?.textContent ?? '').trim()]))`);
  const cpuParsed = JSON.parse(cpuTiles);
  if (cpuParsed.length !== 4) fail(`M4-H: the CPU group has ${cpuParsed.length} tiles (expected 4): ${cpuTiles}`);
  if (cpuParsed.map(([l]) => l).join(',') !== 'Util,Core Frequency,Temperature,Power') {
    fail(`M4N: the CPU group order is '${cpuParsed.map(([l]) => l).join(',')}' (expected Util, Core Frequency, Temperature, Power - Util first)`);
  }
  // M4-I (C2): RID_MOCK_NO_POWER_METER=1 -> the mock cpuPowerW stays null -
  // the Power tile honestly reads '-' (the no-metering shape; the gated
  // pin below asserts it explicitly).
  const wantPower = process.env.RID_MOCK_NO_POWER_METER === '1' ? '-' : '125.5';
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('#dash-readout-cpu .stat-tile')).some((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'Power' && (t.querySelector('.stat-value')?.textContent ?? '') === '${wantPower}')`, 8000))) {
    fail(`M4-H/M4-N: the CPU Power tile is missing/not ${wantPower} W: ${cpuTiles}`);
  }
  for (const want of ['Core Frequency', 'Util', 'Temperature']) {
    if (!cpuParsed.some(([l]) => l === want)) fail(`M4-H: the CPU group is missing the '${want}' tile: ${cpuTiles}`);
  }
  // M4N (A.3): the CPU Core Frequency tile reads the mock cpuFreqMhz 4300
  // as '4.3' GHz (the shared ghzFreq helper) - the value + the unit.
  if (!(await waitFor(win, `(() => {
    const tile = Array.from(document.querySelectorAll('#dash-readout-cpu .stat-tile')).find((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'Core Frequency');
    return !!tile && (tile.querySelector('.stat-value')?.textContent ?? '') === '4.3' && (tile.querySelector('.stat-unit')?.textContent ?? '') === 'GHz';
  })()`, 8000))) {
    fail(`M4N: the CPU Core Frequency tile is not '4.3' GHz: ${cpuTiles}`);
  }
  const gpuTiles = await js(`JSON.stringify(Array.from(document.querySelectorAll('#dash-readout-gpu .stat-tile')).map((t) => [(t.querySelector('.stat-label')?.textContent ?? '').trim(), (t.querySelector('.stat-value')?.textContent ?? '').trim()]))`);
  const gpuParsed = JSON.parse(gpuTiles);
  if (gpuParsed.length !== 8) fail(`M16: the GPU group has ${gpuParsed.length} tiles (expected 8): ${gpuTiles}`);
  if (gpuParsed.map(([l]) => l).join(',') !== 'Util,Core clock,Memory clock,Voltage,VramTemp,Temperature,Power,Fan speed') {
    fail(`M16: the GPU group order is '${gpuParsed.map(([l]) => l).join(',')}' (expected Util, Core clock, Memory clock, Voltage, VramTemp, Temperature, Power, Fan speed - Util first)`);
  }
  for (const want of ['Core clock', 'Memory clock', 'Temperature', 'Power', 'Fan speed', 'Util', 'Voltage', 'VramTemp']) {
    if (!gpuParsed.some(([l]) => l === want)) fail(`M16: the GPU group is missing the '${want}' tile: ${gpuTiles}`);
  }
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('#dash-readout-gpu .stat-tile')).some((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'Util' && (t.querySelector('.stat-value')?.textContent ?? '') === '42')`, 8000))) {
    fail(`M4-H: the GPU Util tile is not 42 (the mock utilPct): ${gpuTiles}`);
  }
  // M4N (A.2): the GPU Power tile reads the mock powerW fixture 38.8.
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('#dash-readout-gpu .stat-tile')).some((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'Power' && (t.querySelector('.stat-value')?.textContent ?? '') === '38.8')`, 8000))) {
    fail(`M4N: the GPU Power tile is not 38.8 (the mock powerW fixture): ${gpuTiles}`);
  }
  // M16: the Voltage + VramTemp tiles read the mock telemetry (0.652 V /
  // the 44..53 °C ramp).
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('#dash-readout-gpu .stat-tile')).some((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'Voltage' && (t.querySelector('.stat-value')?.textContent ?? '') === '0.652')`, 8000))) {
    fail(`M16: the GPU Voltage tile is not 0.652 (the mock gpuVoltageV): ${gpuTiles}`);
  }
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('#dash-readout-gpu .stat-tile')).some((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'VramTemp' && /^\\d+$/.test(t.querySelector('.stat-value')?.textContent ?? ''))`, 8000))) {
    fail(`M16: the GPU VramTemp tile is missing (expected the 44..53 °C ramp): ${gpuTiles}`);
  }
  step('m4h-readout-groups', `M4-H/M4M/M4N/M16: readout groups 'CPU,GPU'; CPU 4 tiles in order '${cpuParsed.map(([l]) => l).join(',')}' (incl. Power '${cpuParsed.find(([l]) => l === 'Power')?.[1]} W', Core Frequency '4.3 GHz'), GPU 8 tiles in order '${gpuParsed.map(([l]) => l).join(',')}' (incl. Util '42' + Power '38.8' + Voltage '0.652' + VramTemp - Util first in both)`);

  // --- M4-D2 (§3): the ReBAR pill is STANDALONE (no label kv row) --------
  // The mock fixture models a healthy setup: a multi-GiB BAR (rebarActive
  // true -> green 'ReBAR on'). The row that used to wrap it ("Resizable
  // BAR" kv) and the PCIe row are GONE.
  if (await js(`!!document.querySelector('.card-grid .kv[data-label="Resizable BAR"]')`)) {
    fail('M4-D2: the "Resizable BAR" label row is still rendered (the pill must be standalone)');
  }
  const rebarPill = await js(`(() => {
    const pill = document.querySelector('.card-grid .rebar-pill');
    if (!pill) return 'no-pill';
    return pill.textContent + '|' + pill.className;
  })()`);
  if (!/ReBAR on\|.*status-ok/.test(rebarPill)) fail(`M4-D2: the standalone ReBAR pill is '${rebarPill}' (expected the green 'ReBAR on')`);
  step('m4d2-gpu-rows', `GPU card: ReBAR standalone pill '${rebarPill.split('|')[0]}' (green), no PCIe row, no Resizable BAR label row`);

  // ONE general GPU STATUS card (M3-A + M3-C-I + M4-A + M16): FIVE rows,
  // honest per-row state, no Level Zero item, no IGCL detail line, NO
  // clocks row (dashboard picture); M16: the card title is 'GPU Status'
  // and the DEVICE row renders ABOVE the driver row (the flip); the OC row
  // reads the stock-state text ('No Overclock Applied' / 'Overclock
  // Applied'); driver row detail = version + date like the device card;
  // app row healthy detail = "App & Service Running"; the M4-A waiver row
  // is the ONLY persistent waiver display in the app.
  if (!(await waitFor(win, `document.querySelectorAll('.health-card').length === 1`))) fail('expected exactly one GPU Status card');
  const statusTitle = await js(`document.querySelector('.health-card .card-title')?.textContent ?? ''`);
  if (statusTitle.trim() !== 'GPU Status') fail(`health card title is '${statusTitle}'`);
  if (await js(`document.querySelectorAll('.health-card .health-row').length !== 5`)) {
    fail(`health card rows: got ${await js(`document.querySelectorAll('.health-card .health-row').length`)} (expected 5)`);
  }
  const rowIds = await js(`Array.from(document.querySelectorAll('.health-card .health-row')).map((r) => r.dataset.row).join(',')`);
  if (rowIds !== 'device,driver,oc,waiver,app') fail(`health card rows are '${rowIds}' (expected device,driver,oc,waiver,app - the M16 flip puts the device row FIRST)`);
  const rowLabels = await js(`Array.from(document.querySelectorAll('.health-card .health-row-label')).map((l) => l.textContent).join('|')`);
  for (const want of ['Device detected', 'Driver installed', 'OC status', 'OC waiver', 'Arc Power working']) {
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
  // M16: the OC status row derives from the STOCK STATE - the mock boots
  // at the featureset defaults, so the row reads 'No Overclock Applied'
  // (ok) - never the old last-apply text. The OFFGRID knob
  // (RID_MOCK_OFFGRID_FREQ_MHZ) deliberately boots the mock with a
  // non-stock freq offset (the off-grid readout pin below) - the row then
  // honestly reads 'Overclock Applied' (the knob's own expected shape).
  const ocDetail = await js(`document.querySelector('.health-card .health-row[data-row="oc"] .health-row-detail')?.textContent ?? ''`);
  const offgridBoot = process.env.RID_MOCK_OFFGRID_FREQ_MHZ !== undefined;
  const wantOcDetail = offgridBoot ? 'Overclock Applied' : 'No Overclock Applied';
  if (ocDetail.trim() !== wantOcDetail) fail(`M16: the OC status row reads '${ocDetail}' (expected '${wantOcDetail}'${offgridBoot ? ' - the off-grid fixture boots with a non-stock freq offset' : ' - the mock boots at stock'})`);
  // The mock boot state: driver + device + app rows ok, OC row ok (stock),
  // the waiver row drives the unknown/error dot.
  const dots = await js(`Array.from(document.querySelectorAll('.health-card .health-row .status-dot')).map((d) => d.className).join('|')`);
  if (!/status-ok/.test(dots)) fail(`no ok dot on the health card: '${dots}'`);
  if (await js(`document.querySelector('.health-card')?.textContent.includes('Level Zero')`)) fail('Level Zero is still a health item');
  if (await js(`!!document.querySelector('.igs-toggle')`)) fail('M3-A: the IGS toggle button is still rendered');
  step('health-card', `one 'GPU Status' card: rows '${rowLabels}' (device above driver), driver '${driverDetail.trim()}', oc '${ocDetail.trim()}', app '${appDetail.trim()}'`);

  // --- M4-A (correction): the waiver STATUS row in the health card ---
  // The ONLY persistent waiver display in the app: green "Accepted" when the
  // store caps say accepted, red "Not Accepted" otherwise - read LIVE at
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
  if (waiverClickable === bootAccepted) fail(`M4-A: waiver row clickability is '${waiverClickable}' (expected ${!bootAccepted} - clickable only while unaccepted)`);
  step('waiver-row', `health-card waiver row: 'OC waiver - ${waiverExpected}' (${bootAccepted ? 'green, no click action' : 'red, clickable'})`);

  if (!bootAccepted) {
    // M4-A review F1: the unaccepted row is CLICKABLE - click it: the waiver
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

  // --- M4-F: multi-device block (RID_MOCK_MULTI_DEVICE=1) ------------------
  // The mock enumerates devices 0 AND 1 (device 1 = the arc-igpu line) -
  // every pin here runs ONLY in the multi-device session and RESTORES the
  // device-0 session state before the flow continues:
  //   1. the selector renders BOTH names on the Dashboard GPU card + the
  //      Tuning tab (and is ABSENT in the single-device default - the
  //      selector-absent pin below);
  //   2. switching via the dashboard selector changes the header name +
  //      caps + state (device 1 is telemetry-only: no ranges, no controls -
  //      the Tuning page degrades to the no-OC note, never device-0's
  //      ranges);
  //   3. F1: a featureset SWAP while device 1 is selected re-reads the
  //      CURRENT device's pair - the swap never pairs device 1 with
  //      device-0's (b580) ranges;
  //   4. the telemetry switches (per-device ramps - the readout reflects
  //      device 1's values: 1067 MHz memory clock vs the a770's 2187 MHz);
  //   5. the persisted deviceId survives a profiles-settings-save round
  //      trip (S3: toggling monitorLogToFile must not clobber device-set's
  //      write);
  //   6. the boot apply targets the selected device (mock:run-boot-apply
  //      with an active profile + ocOnBoot seeded via profiles-settings-
  //      save - the OTHER device's state unchanged);
  //   7. switching BACK via the Tuning selector restores the a770 surface
  //      (both selectors drive the same selectDevice flow).
  if (process.env.RID_MOCK_MULTI_DEVICE === '1') {
    const A770_NAME = 'Mock Arc A770 Graphics (fixture) 16GB GDDR6';
    const IGPU_NAME = 'Mock Arc iGPU (fixture)';
    const driveSelector = (value) => js(`(() => {
      const s = document.querySelector('.device-select');
      if (!s) return 'no-select';
      s.value = '${value}';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`);
    const selectorOptions = () => js(`JSON.stringify(Array.from(document.querySelectorAll('.device-select option')).map((o) => [o.value, o.textContent]))`);

    // (1) the dashboard GPU card selector renders BOTH device names, the
    // current selection is device 0.
    if (!(await waitFor(win, `!!document.querySelector('.card-grid .device-select')`, 5000))) {
      fail('M4-F: the device selector is missing on the Dashboard GPU card (multi-device session)');
    }
    const dashOpts = JSON.parse(await selectorOptions());
    const dashNames = dashOpts.map(([, t]) => t);
    if (dashOpts.length !== 2 || !dashNames.includes(A770_NAME) || !dashNames.includes(IGPU_NAME)) {
      fail(`M4-F: the dashboard selector options are ${JSON.stringify(dashOpts)} (expected both '${A770_NAME}' and '${IGPU_NAME}')`);
    }
    if (dashOpts.find(([v]) => v === '0')?.[1] !== A770_NAME) fail(`M4-F: the dashboard selector mislabels device 0: ${JSON.stringify(dashOpts)}`);
    const dashSelValue = await js(`document.querySelector('.card-grid .device-select').value`);
    if (dashSelValue !== '0') fail(`M4-F: the dashboard selector does not show device 0 selected at boot: '${dashSelValue}'`);
    step('m4f-selector-dashboard', `M4-F: dashboard GPU-card selector renders both devices (${dashOpts.map(([v, t]) => v + '=' + t).join(', ')}), current '${dashSelValue}'`);

    // (2) switch to device 1 via the DASHBOARD selector: the header name,
    // caps + state change; the Tuning page degrades to the no-OC note.
    if ((await driveSelector('1')) !== 'ok') fail('M4-F: the dashboard selector change did not dispatch');
    if (!(await waitFor(win, `(document.querySelector('.gpu-name')?.textContent ?? '').trim() === '${IGPU_NAME}'`, 8000))) {
      fail(`M4-F: the header did not switch to device 1: '${await js(`document.querySelector('.gpu-name')?.textContent ?? ''`)}' (expected '${IGPU_NAME}')`);
    }
    const igpuCaps = await js(`window.arcPower.getCapabilities(1)`);
    if (Object.keys(igpuCaps.ranges ?? {}).length !== 0 || Object.values(igpuCaps.controls ?? {}).some(Boolean)) {
      fail(`M4-F: device-1 caps are not the telemetry-only surface: ${JSON.stringify({ ranges: igpuCaps.ranges, controls: igpuCaps.controls })}`);
    }
    // M17f (step-4 N2): the sysman PL2 read is DEVICE-SCOPED - device 1
    // (the telemetry-only iGPU, no power-limit control) answers the honest
    // null while device 0 mirrors its OWN fixture (the hardcoded-device-0
    // bug masked the iGPU's '-' with the a770's 210 W pair).
    const igpuLimits = await js(`window.arcPower.powerLimitsRead(1)`);
    if (igpuLimits !== null) {
      fail(`M17f (N2): the sysman read on device 1 answers ${JSON.stringify(igpuLimits)} (expected null - the iGPU has no power-limit control; the read must be device-scoped, never device-0's fixture mirror)`);
    }
    const a770Limits = await js(`window.arcPower.powerLimitsRead(0)`);
    if (a770Limits === null || a770Limits.sustainedW !== 210 || a770Limits.burstW !== 210) {
      fail(`M17f (N2): the sysman read on device 0 answers ${JSON.stringify(a770Limits)} (expected the a770 210 W fixture mirror - the read keys on the requested device)`);
    }
    step('m17f-pl2-device-scoped', `M17f (N2): the sysman PL2 read is device-scoped - device 1 null (no power-limit control), device 0 the a770 210 W mirror`);
    if (!(await waitFor(win, `window.arcPower.deviceGet().then((d) => d.deviceId === 1)`, 8000))) {
      fail(`M4-F: the switch did not persist deviceId=1 (deviceGet=${JSON.stringify(await js(`window.arcPower.deviceGet()`))})`);
    }
    await gotoOverclocking();
    if (!(await waitFor(win, `document.querySelectorAll('.oc-card').length === 0 && document.body.textContent.includes('No overclocking controls are available')`, 8000))) {
      fail(`M4-F: the Tuning page did not degrade to the no-OC note on device 1 (cards=${await js(`document.querySelectorAll('.oc-card').length`)}; page='${(await js(`(document.getElementById('page')?.textContent ?? '').slice(0, 200)`)).slice(0, 200)}')`);
    }
    // the Tuning tab renders the selector too, with BOTH names.
    if (!(await waitFor(win, `!!document.querySelector('.oc-mode-row .device-select')`, 5000))) {
      fail('M4-F: the device selector is missing on the Tuning page (multi-device session)');
    }
    const tuneOpts = JSON.parse(await selectorOptions());
    if (tuneOpts.length !== 2 || !tuneOpts.some(([v, t]) => v === '1' && t === IGPU_NAME)) {
      fail(`M4-F: the Tuning selector options are ${JSON.stringify(tuneOpts)} (expected both devices, incl. '${IGPU_NAME}')`);
    }
    step('m4f-switch', `M4-F: dashboard selector -> device 1: header '${IGPU_NAME}', caps telemetry-only (no ranges/controls), deviceGet=1 persisted, Tuning no-OC note, Tuning selector renders both names`);

    // (3) F1: a featureset swap while device 1 is selected must re-read the
    // CURRENT device's pair - the Tuning page keeps the no-OC note, never
    // b580's percent ranges (the swap response carries device-0's pair).
    const swapFsTo = (id) => js(`(() => {
      const s = document.querySelector('.featureset-select');
      s.value = '${id}';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await swapFsTo('b580');
    if (!(await waitFor(win, `document.body.textContent.includes('No overclocking controls are available')`, 8000))) {
      fail(`M4-F (F1): after a swap to b580 the Tuning page paired device 1 with device-0's ranges (page='${(await js(`(document.getElementById('page')?.textContent ?? '').slice(0, 200)`)).slice(0, 200)}')`);
    }
    if (await js(`document.querySelectorAll('.oc-card').length !== 0`)) {
      fail('M4-F (F1): b580 control cards rendered for device 1 (the swap must re-read the CURRENT device)');
    }
    await swapFsTo('a770');
    if (!(await waitFor(win, `(document.querySelector('.featureset-select').value) === 'a770' && document.body.textContent.includes('No overclocking controls are available')`, 8000))) {
      fail('M4-F (F1): the swap back to a770 did not restore the session (device 1 must stay the no-OC surface)');
    }
    step('m4f-f1-swap', 'M4-F (F1): swap b580 -> a770 while device 1 is selected - the Tuning page stays the no-OC note (the current device is re-read, never paired with device-0 ranges)');

    // (4) the telemetry switched: the readout reflects device 1's ramp
    // (memClock 1067 vs the a770's 2187; core base 2000 MHz on the card).
    await js(`location.hash = '#/dashboard'`);
    if (!(await waitFor(win, `Array.from(document.querySelectorAll('#dash-readout-gpu .stat-tile')).some((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'Memory clock' && (t.querySelector('.stat-value')?.textContent ?? '') === '1067')`, 10000))) {
      fail(`M4-F: the readout does not reflect device 1's telemetry (memory clock = ${await js(`Array.from(document.querySelectorAll('#dash-readout-gpu .stat-tile')).find((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'Memory clock')?.querySelector('.stat-value')?.textContent ?? ''`)} - expected 1067, the device-1 ramp)`);
    }
    if (!(await waitFor(win, `(() => {
      const row = Array.from(document.querySelectorAll('.card-grid .kv')).find((k) => (k.getAttribute('data-label') ?? '') === 'Clocks');
      return (row?.textContent ?? '').includes('2000 MHz Core') && (row?.textContent ?? '').includes('1067');
    })()`, 5000))) {
      fail(`M4-F: the Clocks kv does not reflect device 1 (got '${await js(`document.querySelector('.card-grid .kv[data-label="Clocks"]')?.textContent ?? ''`)}' - expected '2000 MHz Core / 1067 MHz Memory')`);
    }
    step('m4f-telemetry', 'M4-F: telemetry switched with the device - readout shows the device-1 ramp (Memory clock 1067 MHz, Clocks kv 2000 MHz Core / 1067 MHz Memory)');

    // (5) S3: the persisted deviceId survives a profiles-settings-save
    // round trip (toggle monitorLogToFile - a Settings/Profiles save must
    // never clobber device-set's write).
    await js(`window.arcPower.profilesSettingsSave({ monitorLogToFile: true })`);
    await js(`window.arcPower.profilesSettingsSave({ monitorLogToFile: false })`);
    const s3Device = await js(`window.arcPower.deviceGet()`);
    if (s3Device.deviceId !== 1) {
      fail(`M4-F (S3): profiles-settings-save clobbered the persisted deviceId (deviceGet=${JSON.stringify(s3Device)} after a monitorLogToFile round trip - expected 1)`);
    }
    step('m4f-s3-save', 'M4-F (S3): the persisted deviceId survives a profiles-settings-save round trip (monitorLogToFile toggled, deviceGet still 1)');

    // (6) the boot apply targets the SELECTED device: seed the precondition
    // (active profile + ocOnBoot via profiles-settings-save), temporarily
    // accept device 1's waiver (the default session is unaccepted), run the
    // REAL boot-apply flow via mock:run-boot-apply. A device-1 target hits
    // the telemetry-only surface: the PL profile control is unsupported ->
    // the honest fallback-skipped refusal (applied false, reason 'defaults
    // restore skipped') - while a device-0 target (the S2 bug) would have
    // APPLIED the 250 W profile. The OTHER device's state stays unchanged.
    await js(`window.arcPower.profilesSave({ id: 'boot-probe-multi', name: 'boot-probe-multi', settings: { powerLimitW: 250 }, ocOnBoot: false })`);
    await js(`window.arcPower.profilesSettingsSave({ ocOnBoot: true, activeProfileId: 'boot-probe-multi' })`);
    const waiverStoreBefore = (await store.loadSettings()).waiverAccepted;
    const device1WaiverBefore = (await backend.getCapabilities(1)).waiverAccepted;
    await backend.setWaiverAccepted(1);
    await store.saveSettings({ ...(await store.loadSettings()), waiverAccepted: true });
    const otherBefore = await js(`window.arcPower.getCurrentSettings(0)`);
    const multiBootOut = await js(`window.arcPower.mockRunBootApply()`);
    if (Math.abs(otherBefore.powerLimitW - 210) > 1e-6) {
      fail(`M4-F: the boot-apply precondition baseline is wrong (device 0 PL = ${otherBefore.powerLimitW}, expected 210)`);
    }
    if (multiBootOut.applied === true) {
      fail(`M4-F: the boot apply APPLIED to device 0 (applied=true) - the S2 bug: the selected device 1 was ignored; device 0 is now ${(await js(`window.arcPower.getCurrentSettings(0)`)).powerLimitW} W`);
    }
    if (!(multiBootOut.reason ?? '').includes('defaults restore skipped')) {
      fail(`M4-F: the boot apply did not target device 1 (reason '${multiBootOut.reason}' - the unsupported-control refusal only occurs when the apply ran against the telemetry-only device 1 with its waiver accepted; a device-0 target would apply the profile or refuse on device 0's waiver)`);
    }
    const otherAfter = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(otherAfter.powerLimitW - 210) > 1e-6) {
      fail(`M4-F: the boot apply CHANGED the other device's state (device 0 PL = ${otherAfter.powerLimitW}, expected unchanged 210)`);
    }
    const multiLog = await js(`window.arcPower.mockBootApplyLog()`);
    const multiLast = Array.isArray(multiLog) ? multiLog[multiLog.length - 1] : null;
    if (!multiLast || multiLast.profileId !== 'boot-probe-multi' || multiLast.applied !== false || !(multiLast.reason ?? '').includes('defaults restore skipped')) {
      fail(`M4-F: the mock boot-apply log does not record the device-1 apply: ${JSON.stringify(multiLog)}`);
    }
    // Restore the session waiver states + the boot-apply precondition.
    await backend.restoreWaiverState(1, device1WaiverBefore);
    await store.saveSettings({ ...(await store.loadSettings()), waiverAccepted: waiverStoreBefore });
    await js(`window.arcPower.profilesSettingsSave({ ocOnBoot: false, activeProfileId: null })`);
    await js(`window.arcPower.profilesDelete('boot-probe-multi')`).catch(() => {});
    step('m4f-boot-apply', `M4-F: mock:run-boot-apply targeted the SELECTED device 1 (${multiBootOut.reason}; log records { profileId 'boot-probe-multi', applied: false }) - device 0 state unchanged (${otherAfter.powerLimitW} W), waiver states restored`);

    // (7) switch BACK via the TUNING selector: the a770 surface returns
    // (header name, control cards, 210 W readout) and the persisted
    // selection follows.
    await gotoOverclocking();
    if (!(await waitFor(win, `!!document.querySelector('.oc-mode-row .device-select')`, 5000))) {
      fail('M4-F: the Tuning selector is missing for the switch back');
    }
    if ((await driveSelector('0')) !== 'ok') fail('M4-F: the Tuning selector change did not dispatch');
    if (!(await waitFor(win, `(document.querySelector('.gpu-name')?.textContent ?? '').trim() === '${A770_NAME}'`, 8000))) {
      fail(`M4-F: the switch back to device 0 failed (header '${await js(`document.querySelector('.gpu-name')?.textContent ?? ''`)}' - expected '${A770_NAME}')`);
    }
    if (!(await waitFor(win, `document.querySelectorAll('.oc-card').length >= 4 && (document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value')?.textContent ?? '').trim() === '210 W'`, 8000))) {
      fail(`M4-F: the Tuning page did not restore the a770 surface after the switch back (cards=${await js(`document.querySelectorAll('.oc-card').length`)}; PL='${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value')?.textContent ?? ''`)}')`);
    }
    if (!(await waitFor(win, `window.arcPower.deviceGet().then((d) => d.deviceId === 0)`, 5000))) {
      fail(`M4-F: the switch back did not persist deviceId=0 (deviceGet=${JSON.stringify(await js(`window.arcPower.deviceGet()`))})`);
    }
    step('m4f-switch-back', `M4-F: Tuning selector -> device 0: header '${A770_NAME}', 4+ control cards, PL '210 W', deviceGet=0 persisted - both selectors drive the same switch`);
  } else {
    // M4-F: single-device degradation - the live 1-GPU machine shows NO
    // selector anywhere (the default variant pins the absent state).
    await sleep(300);
    if (await js(`!!document.querySelector('.device-select')`)) {
      fail('M4-F: the device selector renders with a single device (must be hidden - the honest single-device degradation)');
    }
    step('m4f-selector-absent', 'M4-F: no device selector with 1 device (single-device degradation)');
  }

  // M8 (the Graphics tab): the dedicated verify block (the mock backend -
  // the page reads the mock fixture). Runs in the default variant AND under
  // the RID_MOCK_OVERLAY=1 / RID_MOCK_MULTI_DEVICE=1 variants.
  await runGraphicsVerify(win, backend);

  // --- 2. Tuning page control cards (M4-D2: #/overclocking -> #/tuning) ----
  await gotoOverclocking();
  if (!(await waitFor(win, `document.querySelectorAll('.oc-card').length >= 4`))) {
    fail('expected >= 4 overclocking cards (mock A770 matrix)');
  }
  // M17f: the sysman PL2 read-out - the power-limit card's PL1/PL2 line
  // (the burst domain is invisible to IGCL - the sysman layer is the
  // read-out's source). The mock seam answers the FIXTURE values: the
  // a770's stock default 210 W for both domains at boot (the deterministic
  // one-shot fetch).
  if (!(await waitFor(win, `(document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? '').trim() === 'PL1 210 W / PL2 210 W'`, 5000))) {
    fail(`M17f: the power-limit card PL2 read-out is '${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? ''`)}' (expected 'PL1 210 W / PL2 210 W' - the sysman fixture mirror at boot)`);
  }
  step('m17f-pl2-boot', `M17f: the power-limit card shows the sysman PL1/PL2 read-out '${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? ''`)}' at boot (the one-shot fetch)`);
  // M4-D2 (§8): the page title is 'Tuning' and the view toggle exists at the
  // SAME height as the Stock/Advanced pill (getBoundingClientRect top
  // equality - pinned). M4J clarification: the OC pill renders on EVERY
  // device (the pill is NOT keyed on vramFreqOffset - only the Advanced
  // section below is).
  const tuningTitle = await js(`document.querySelector('.page-title')?.textContent ?? ''`);
  if (tuningTitle.trim() !== 'Tuning') fail(`M4-D2: the page title is '${tuningTitle}' (expected 'Tuning' - the Overclocking rename)`);
  const pillHeights = await js(`(() => {
    const ocPill = Array.from(document.querySelectorAll('.oc-mode-toggle')).find((t) => Array.from(t.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Stock'));
    const viewPill = Array.from(document.querySelectorAll('.oc-mode-toggle')).find((t) => Array.from(t.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Fan Curve'));
    if (!ocPill || !viewPill) return JSON.stringify({ noPills: true });
    const oc = ocPill.getBoundingClientRect();
    const v = viewPill.getBoundingClientRect();
    return JSON.stringify({ ocTop: Math.round(oc.top), vTop: Math.round(v.top), ocBottom: Math.round(oc.bottom), vBottom: Math.round(v.bottom) });
  })()`);
  const pillBox = JSON.parse(pillHeights);
  if (pillBox.noPills || pillBox.ocTop !== pillBox.vTop) fail(`M4-D2: the view pill is not at the SAME HEIGHT as the OC pill: ${pillHeights}`);
  if (pillBox.ocBottom !== pillBox.vBottom) fail(`M4-D2: the view pill top aligns but the bottoms differ (different heights): ${pillHeights}`);
  const viewToggleState = await js(`JSON.stringify(Array.from(document.querySelectorAll('.tuning-view-btn')).map((b) => [b.textContent.trim(), b.classList.contains('active')]))`);
  if (!/\["Tuning",true\]/.test(viewToggleState)) fail(`M4-D2: the view toggle does not show Tuning active on a '#/tuning' visit: ${viewToggleState}`);
  // M4-H (A3)/M4J clarification: on the TUNING view the OC-mode column is
  // PRESENT on EVERY device (the fan-hide class is off and the
  // Stock/Advanced pills render) - the user clarified that "Advanced gone
  // for Alchemist" means only the bottom Advanced section, never the pill.
  const tuningRowState = await js(`(() => {
    const row = document.querySelector('.oc-mode-row');
    if (!row) return 'no-row';
    const hasClass = row.classList.contains('fan-hides-oc-column');
    const stockVisible = Array.from(row.querySelectorAll('.oc-mode-btn')).some((b) => b.textContent.trim() === 'Stock' && b.offsetParent !== null);
    const advancedVisible = Array.from(row.querySelectorAll('.oc-mode-btn')).some((b) => b.textContent.trim() === 'Advanced' && b.offsetParent !== null);
    return JSON.stringify({ hasClass, stockVisible, advancedVisible });
  })()`);
  const tuneRowState = JSON.parse(tuningRowState);
  if (tuneRowState.hasClass || !tuneRowState.stockVisible || !tuneRowState.advancedVisible) {
    fail(`M4-H: the OC-mode column must be PRESENT on the tuning view (class ${tuneRowState.hasClass}, Stock visible ${tuneRowState.stockVisible}, Advanced visible ${tuneRowState.advancedVisible})`);
  }
  // M4-I (E1): the row order is View FIRST, then OC Mode, then the GPU
  // selector (when present - the single-device session has no selector
  // column), then the compact Save button.
  const modeRowOrder = await js(`JSON.stringify(Array.from(document.querySelectorAll('.oc-mode-row .oc-mode-col')).map((c) => (c.querySelector('.oc-mode-label')?.textContent ?? '').trim()))`);
  const orderCols = JSON.parse(modeRowOrder);
  if (orderCols[0] !== 'View' || orderCols[1] !== 'OC mode' || orderCols[orderCols.length - 1] !== 'Profile') {
    fail(`M4-I (E1): the mode-row column order is '${modeRowOrder}' (expected 'View' first, 'OC mode' second, 'Profile' last)`);
  }
  if (orderCols.includes('GPU') && orderCols.indexOf('GPU') !== 2) {
    fail(`M4-I (E1): the GPU selector column must sit right after 'OC mode' (got '${modeRowOrder}')`);
  }
  // M4-I (E2): the compact Save-as-Profile button (btn-sm) sits in the mode
  // row right of the selector, its bounding TOP equal to the pills' (the
  // label-over-button column pattern); the old full-width
  // Save-as-Profile CARD is gone.
  if (!(await waitFor(win, `!!document.querySelector('.oc-mode-row .profile-save-btn')`, 5000))) {
    fail('M4-I: the compact Save-as-Profile button is missing from the mode row');
  }
  if (await js(`!!document.querySelector('.profile-save-card')`)) {
    fail('M4-I (E2): the old full-width Save-as-Profile card is still rendered (replaced by the row button)');
  }
  const saveBtnText = await js(`document.querySelector('.oc-mode-row .profile-save-btn')?.textContent ?? ''`);
  if (saveBtnText.trim() !== 'Save as Profile') fail(`M4-I: the save button reads '${saveBtnText}' (expected 'Save as Profile' - no profile applied yet)`);
  const saveBtnAlign = await js(`(() => {
    const ocPill = Array.from(document.querySelectorAll('.oc-mode-toggle')).find((t) => Array.from(t.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Stock'));
    const btn = document.querySelector('.oc-mode-row .profile-save-btn');
    if (!ocPill || !btn) return 'no-elements';
    return JSON.stringify({ btnTop: Math.round(btn.getBoundingClientRect().top), pillTop: Math.round(ocPill.getBoundingClientRect().top) });
  })()`);
  const btnBox = JSON.parse(saveBtnAlign);
  if (!btnBox || btnBox.btnTop !== btnBox.pillTop) fail(`M4-I (E2): the save button's top ${JSON.stringify(saveBtnAlign)} does not equal the pills' (the button must align in height with the pills)`);
  // M4-D2 (§7): the OLD '#/overclocking' hash (bookmarks + old pins) must
  // land on the Tuning page with the tuning controls - the router alias.
  await js(`location.hash = '#/overclocking'`);
  await sleep(250);
  const aliasTitle = await js(`document.querySelector('.page-title')?.textContent ?? ''`);
  if (aliasTitle.trim() !== 'Tuning') fail(`M4-D2: '#/overclocking' landed on '${aliasTitle}' (expected the Tuning page - the alias redirect)`);
  if (!(await waitFor(win, `document.querySelectorAll('.oc-card').length >= 4`, 5000))) {
    fail('M4-D2: the #/overclocking alias did not render the tuning controls');
  }
  await gotoView('Tuning');
  step('oc', `${await js(`document.querySelectorAll('.oc-card').length`)} control cards rendered; title 'Tuning'; view pill at OC-pill height (${JSON.stringify(pillBox)}); '#/overclocking' alias lands here too`);

  // --- 2b. off-grid driver readout (RID_MOCK_OFFGRID_FREQ_MHZ knob) -------
  const offGridFreq = process.env.RID_MOCK_OFFGRID_FREQ_MHZ;
  if (offGridFreq !== undefined) {
    // The freq card renders in the OFFSET presentation (the only mode -
    // the M4-B Clock mode + the Offset/Clock toggle DIE in M17e) - the
    // off-grid pins read the MHz DRIVER readout.
    await sleep(150);
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

  // --- 2c. M2b-B tuning UX: the freq card TITLE (the M4-B 'Core clock'
  // --- name in every mode - the Offset|Lock toggle is the input
  // --- presentation, not the name) + floating Apply ----------------------
  const freqTitle = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .card-title')?.textContent ?? ''`);
  if (freqTitle.trim() !== 'Core clock') fail(`freq offset card title is '${freqTitle}' (expected 'Core clock' - the M4-B name in the default Offset mode; M17f: it flips to 'GPU Lock' in Lock mode only)`);
  step('label', `freq card title '${freqTitle.trim()}' (the M4-B 'Core clock' name in Offset mode - M17f: the title flips to 'GPU Lock' in Lock mode)`);

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
  // (bootAccepted / persistedWaiver were read right after the boot step -
  // the dashboard health-row section already consumed them.)

  // ocOnBoot gate check (M2b-B): with an unaccepted waiver the start-at-boot
  // checkbox must be disabled; after acceptance it is enabled.
  if (!bootAccepted) {
    await js(`location.hash = '#/profiles'`);
    if (!(await waitFor(win, `!!document.querySelector('.boot-checkbox')`))) fail('boot checkbox did not render');
    if (!(await js(`document.querySelector('.boot-checkbox').disabled`))) fail('start-at-boot must be gated on the waiver (unaccepted)');
    // M4-D: in an UNACCEPTED session the profile LOAD PROMPTS - the
    // classic waiver gate. Create a throwaway profile, click Load, Cancel
    // the dialog: the load is aborted, the device stays untouched (the
    // accepted-store variants never see this - their loads are silent).
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
    await gotoOverclocking();
  }
  // M3-C review F4: the navigation above re-rendered the OC page from the
  // driver state (210 W), dropping the earlier 220 W slider move. The
  // isolated mock data dir makes the unaccepted-waiver branch reachable on
  // a FRESH store, so re-move the slider deterministically - the readout
  // checks below must not depend on a persisted acceptance from a previous
  // run.
  await setSlider(220);

  const readoutBefore = await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value').textContent`);
  if (readoutBefore.trim() !== '220 W') fail(`slider readout is '${readoutBefore}' (expected '220 W')`);
  step('slider', `power slider set to 220 W (readout '${readoutBefore}')`);

  // --- M4-A (correction): the OC page renders NO waiver status --------
  // The status row lives ONLY in the dashboard GPU Status card; this page
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
    // M4-B: a SAVED waiver must survive the boot AND the apply - the
    // clock write lands with no waiver-not-set and the device still reports
    // the acceptance afterwards (the persisted flag is not consumed).
    const waiverAfter = await js(`window.arcPower.waiverGet(0)`);
    if (waiverAfter.accepted !== true) fail('M4-B: the waiver acceptance was lost across the apply (persisted-accepted session)');
    step('waiver-persisted', `waiver accepted at boot (persisted or boot-accept): apply without dialog -> read-back ${state.powerLimitW} W, waiverGet still accepted`);
    // M4-D (PERMANENT acceptance): an ACCEPTED store + a driver that
    // loses the waiver mid-session - the apply is SILENTLY re-set + retried
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
    // sections below expect 220 W applied and EXACTLY ONE success toast -
    // the restore apply's toast is the one they count).
    await clearToasts();
    await setSlider(220);
    await clickApply();
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4-D: the 220 W baseline restore after the silent retry did not land');
  } else {
    // M3-C review F4: with the isolated mock data dir the unaccepted branch
    // is reachable on a FRESH store (pre-fix, the shared real settings.json
    // always carried a persisted acceptance, so this branch was dead). The
    // apply click is what triggers the dialog - it was missing here.
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
    // (the profiles twin is pinned below via m4d-profiles-retry - this pins
    // the OC page's copy of the SAME never-accepted-session defense, which
    // ui-verify no longer exercised after the accepted-store silent retry
    // replaced the old dialog-based re-prompt pin). The gate Accept above
    // persisted the acceptance; simulate a NEVER-ACCEPTED session at apply
    // time - the STORE loses the persisted acceptance (settings.json) while
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
    // No gate dialog was clicked - the dialog must appear BY ITSELF (the
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

  // M4-A: the dashboard health row now reflects the acceptance - the
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
  await gotoOverclocking();
  step('waiver-row-live', 'dashboard waiver row flipped to Accepted (re-render on the caps patch)');

  // M3-C-F: the "Driver:" readout refreshes from the FRESH state after the
  // apply - WITHOUT navigating away (previously built once at render, the
  // stale part that forced the leave-and-return dance).
  const driverAfterApply = await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-driver-value')?.textContent ?? ''`);
  if (!driverAfterApply.includes('220')) {
    fail(`M3-C-F: driver readout is '${driverAfterApply}' after the apply (expected the fresh 220 W)`);
  }
  step('oc-fresh-driver', `M3-C-F: driver readout updated in place to '${driverAfterApply.trim()}' (no navigation)`);
  // M17f: the PL2 read-out freshness = PER-APPLY - the sysman line
  // re-fetches after the apply (the mock seam mirrors the backend state,
  // so the burst follows the sustained to 220 W).
  if (!(await waitFor(win, `(document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? '').trim() === 'PL1 220 W / PL2 220 W'`, 5000))) {
    fail(`M17f: the PL2 read-out did not refresh after the apply: '${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? ''`)}' (expected 'PL1 220 W / PL2 220 W' - the per-apply freshness)`);
  }
  step('m17f-pl2-fresh', `M17f: the PL2 read-out refreshed after the apply to '${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? ''`)}' (per-apply)`);

  // --- 3b. M2b-B no-op suppression: the payload carries all 4 controls, but
  // --- only power changed -> EXACTLY one success toast (the no-ops stay
  // --- silent). Off-grid fixture: freq is also dirty -> two toasts.
  // M4J (note): the M4-D retry flow above consumed the ORIGINAL off-grid
  // dirtiness (the snapped freq 48 was applied on the retry's first
  // attempt, and the baseline apply set power 220) - for the off-grid
  // variant, re-dirty BOTH controls deterministically so ONE apply produces
  // the two toasts this pin counts, then restore the 220 baseline the later
  // sections expect (the pre-fix pin counted a stale state and failed since
  // M4-D).
  if (offGridFreq !== undefined) {
    await clearToasts();
    await js(`(() => {
      const card = document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"]');
      const input = card.querySelector('input[type="range"]');
      input.value = '49';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await setSlider(230); // power 230 vs the baseline 220 -> dirty
    await clickApply(); // -> 2 toasts (power 230 + freq 49)
  }
  const expectedToasts = offGridFreq !== undefined ? 2 : 1;
  if (!(await waitFor(win, `document.querySelectorAll('.toast-success').length === ${expectedToasts}`, 5000))) {
    fail(`expected ${expectedToasts} success toast(s) (no-op suppression), got ${await js(`document.querySelectorAll('.toast-success').length`)}`);
  }
  if (offGridFreq !== undefined) {
    // Restore the 220 W baseline the later sections (driver readout, reset,
    // B5) expect.
    await clearToasts();
    await setSlider(220);
    await clickApply();
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4J: the off-grid 220 W baseline restore after the toast count did not land');
    await clearToasts();
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
  // (M3-A: the IGS-on/IGS-off refusal variants are unified - IGS is no
  // longer a status item, and the refusal wording never named IGS anyway.)

  // B5 first: simulate a read-back that LAGS (the driver write succeeded,
  // the read-back still reports the old value). After the successful apply
  // the chip must show 'Applied' and the button must hide against the
  // APPLIED reference, even though the driver still reads 210.
  // M17d (Run D - the V1-call pin): in the mock's ADVANCED default mode the
  // W/C controls route through the V1 (extended) setters, so the lag must
  // be simulated on BOTH paths - the driverstore wrap (freq/volt) AND the
  // extendedApply wrap (the PL/TL writes the split routes to the mock old
  // runtime).
  const realApply = backend.applySettings.bind(backend);
  backend.applySettings = async (d, s) => {
    const before = backend._state.powerLimitW;
    const res = await realApply(d, s);
    backend._state.powerLimitW = before; // the read-back lags
    return res;
  };
  const realExtended = backend.extendedApply.bind(backend);
  backend.extendedApply = async (control, value) => {
    const before = backend._state[control];
    const res = await realExtended(control, value);
    backend._state[control] = before; // the read-back lags
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
    if (s !== 'Applied') fail(`M3-C-G: chip '${c}' is '${s}' (expected 'Applied' - the control was in the applied payload)`);
  }
  if (!(await floatingHidden())) fail('B5: floating Apply still visible after a successful apply (read-back lags)');
  step('b5-lag', `B5/G: apply ok with lagging read-back (${lagState.powerLimitW} W) -> chip 'Applied', others hidden, Apply hidden`);
  await clearToasts();
  // Restore the real backend and re-render the OC page fresh (values snap
  // back to the 210 W read-back; the applied reference is per-page state).
  backend.applySettings = realApply;
  backend.extendedApply = realExtended;
  await js(`location.hash = '#/dashboard'`);
  await gotoOverclocking();
  if (!(await floatingHidden())) fail('floating Apply visible on a clean re-render');
  // M3-C-G: on a fresh re-render no control was applied in this render -
  // every chip is hidden again.
  const freshChips = await js(`JSON.stringify(Array.from(document.querySelectorAll('.oc-card')).map((c) => c.querySelector('.oc-chip-status')?.hidden !== false))`);
  if (!JSON.parse(freshChips).every(Boolean)) fail('M3-C-G: a chip is visible on a clean re-render (applied reference is per-render state)');
  step('b5-fresh', 'B5: fresh re-render is clean (applied reference is per-render state)');

  // --- M9: the per-card Apply button (the chip state machine) --------------
  // Pristine cards carry the hidden chip AND no .oc-chip-apply button (the
  // CSS [hidden] fix makes the empty pill truly invisible); moving a slider
  // reveals THAT card's Apply button only; clicking it applies the card
  // only (the single-control payload through the shared apply machinery);
  // the card then shows the green 'Applied' chip + the button hides; a
  // further change brings the button back. The old 'Unapplied' chip text
  // must not exist anywhere in the DOM.
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('.oc-card')).every((c) => {
    const chip = c.querySelector('.oc-chip-status');
    const btn = c.querySelector('.oc-chip-apply');
    return !!chip && chip.hidden && (!btn || btn.hidden);
  })`, 8000))) {
    fail('M9: a pristine Tuning card must carry the hidden chip and no VISIBLE .oc-chip-apply button');
  }
  if (await js(`document.body.textContent.includes('Unapplied')`)) fail('M9: the "Unapplied" chip text must not exist anywhere in the DOM');
  await setSlider(230);
  if (!(await waitFor(win, `(() => {
    const card = document.querySelector('.oc-card[data-control="powerLimitW"]');
    const btn = card ? card.querySelector('.oc-chip-apply') : null;
    return !!btn && !btn.hidden && (btn.textContent ?? '').trim() === 'Apply';
  })()`, 5000))) {
    fail('M9: moving the power slider must reveal its .oc-chip-apply button');
  }
  const otherButtons = await js(`Array.from(document.querySelectorAll('.oc-card')).filter((c) => c.dataset.control !== 'powerLimitW').some((c) => {
    const b = c.querySelector('.oc-chip-apply');
    return !!b && !b.hidden;
  })`);
  if (otherButtons) fail('M9: only the changed card may show its Apply button');
  await clearToasts();
  await js(`(() => { const b = document.querySelector('.oc-card[data-control="powerLimitW"] .oc-chip-apply'); b.click(); })()`);
  if (!(await waitFor(win, `(() => {
    const c = document.querySelector('.oc-card[data-control="powerLimitW"] .oc-chip-status');
    return !!c && !c.hidden && (c.textContent ?? '').trim() === 'Applied' && c.className.includes('chip-ok');
  })()`, 8000))) {
    fail(`M9: the per-card apply did not flip the powerLimitW chip to 'Applied' (driver power='${(await js(`window.arcPower.getCurrentSettings(0)`)).powerLimitW}')`);
  }
  if (!(await waitFor(win, `(() => {
    const b = document.querySelector('.oc-card[data-control="powerLimitW"] .oc-chip-apply');
    return !!b && b.hidden;
  })()`, 5000))) {
    fail('M9: the per-card Apply button must hide after its successful apply');
  }
  if ((await js(`window.arcPower.getCurrentSettings(0)`)).powerLimitW !== 230) {
    fail(`M9: the per-card apply did not reach the mock driver (power='${(await js(`window.arcPower.getCurrentSettings(0)`)).powerLimitW}')`);
  }
  await setSlider(240);
  if (!(await waitFor(win, `(() => {
    const b = document.querySelector('.oc-card[data-control="powerLimitW"] .oc-chip-apply');
    return !!b && !b.hidden;
  })()`, 5000))) {
    fail('M9: the per-card Apply button must return after the setting changes again');
  }
  // Restore the deterministic power baseline the io-failed section expects
  // (the driver must read 210 W there - the apply below).
  await clearToasts();
  await js(`(() => { const b = document.querySelector('.oc-card[data-control="powerLimitW"] .oc-chip-apply'); b.click(); })()`);
  if (!(await waitFor(win, `(() => {
    const c = document.querySelector('.oc-card[data-control="powerLimitW"] .oc-chip-status');
    return !!c && !c.hidden && (c.textContent ?? '').trim() === 'Applied';
  })()`, 8000))) {
    fail('M9: the restore per-card apply did not flip the powerLimitW chip back to Applied');
  }
  // Restore the deterministic 210 W baseline the io-failed section expects
  // (the driver must read 210 there).
  await setSlider(210);
  if (!(await waitFor(win, `(() => {
    const b = document.querySelector('.oc-card[data-control="powerLimitW"] .oc-chip-apply');
    return !!b && !b.hidden;
  })()`, 5000))) {
    fail('M9: the baseline restore must reveal the per-card Apply button');
  }
  await clearToasts();
  await js(`(() => { const b = document.querySelector('.oc-card[data-control="powerLimitW"] .oc-chip-apply'); b.click(); })()`);
  if (!(await waitFor(win, `(() => {
    const c = document.querySelector('.oc-card[data-control="powerLimitW"] .oc-chip-status');
    return !!c && !c.hidden && (c.textContent ?? '').trim() === 'Applied';
  })()`, 8000))) {
    fail('M9: the baseline restore apply did not flip the powerLimitW chip back to Applied');
  }
  step('m9-per-card-apply', `M9: per-card Apply - pristine cards carry only the hidden chip; moving the slider revealed the card's Apply button; its click applied powerLimitW 230 through the mock (chip 'Applied', button hidden, driver power=230); a further change brought the button back; the restore apply returned 240 W then the baseline 210 W; 'Unapplied' never rendered`);

  // An io-failed powerLimit apply fails INSTANTLY and the toast is the plain
  // driver message + code (M2C-C: the IGS-naming wording is REMOVED - the
  // real gate was elevation, docs §8c).
  // M17d (Run D - the V1-call pin): in the mock's ADVANCED default mode the
  // W/C applies route the V1 (extended) setters, whose mock path has no
  // failure injection - the io-failed is injected on the EXTENDED path here
  // (the driverstore-path injectFail cannot reach an advanced-mode W/C
  // apply anymore). The same wrap covers the one-shot section below: it
  // fails powerLimitW until `shotInjected` flips, then passes through.
  backend.injectFail('powerLimitW', 'io-failed');
  const realExtIo = backend.extendedApply.bind(backend);
  let shotInjected = false;
  backend.extendedApply = async (control, value) => {
    if (control === 'powerLimitW' && !shotInjected) {
      shotInjected = true;
      return { ok: false, errorCode: 'io-failed', readBackEqual: false, message: 'IGCL io-failed' };
    }
    return realExtIo(control, value);
  };
  await setSlider(220);
  await clearToasts();
  await clickApply();
  if (!(await waitFor(win, `!!document.querySelector('.toast-error')`, 10000))) {
    fail('io-failed error toast missing (instant apply)');
  }
  const refusalMsg = await js(`document.querySelector('.toast-error .toast-message')?.textContent ?? ''`);
  // M17d (Run D): the refusal now surfaces from the V1 (extended) path -
  // the bundled runtime's OWN message is the per-control text (the
  // applyFailureText preference: the message wins; the driverstore-path
  // 'refused the change' composition lives in applyOnce and no longer sees
  // advanced-mode W/C applies). The honest asserts stay: the error code is
  // in the toast, the obsolete IGS wording is gone, no retry note.
  if (!/io-failed/.test(refusalMsg)) fail(`refusal toast is missing the error code: '${refusalMsg}'`);
  if (/Intel Graphics Software/.test(refusalMsg)) fail(`M2C-C: refusal toast still names IGS (obsolete wording): '${refusalMsg}'`);
  if (await js(`!!document.querySelector('.toast-warn')`)) fail('instant apply must NOT show a retry note');
  // The "Applying - retry N/9" surface is gone: the button never shows it.
  const btnLabel = await js(`document.querySelector('.floating-apply')?.textContent ?? ''`);
  if (btnLabel.includes('retry')) fail(`floating Apply shows a retry label: '${btnLabel}'`);
  // A one-shot io-failed backend (would succeed on a retry) must STILL
  // fail instantly - no retry attempt ever happens. Re-arm the one-shot
  // extended-path wrap (the persistent section above consumed its shot) and
  // apply again: the flow must NOT retry (a retry would succeed on the
  // re-armed pass-through and toast success).
  shotInjected = false;
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
  backend.extendedApply = realExtIo;
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
  // The freq card renders in the offset presentation by default - the M4-B
  // pins read the OFFSET slider (-300..300), the visible Offset|Clock row
  // and the 'Core clock' title.
  await sleep(150);
  const setFreqSlider = (value) => js(`(() => {
    const card = document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"]');
    const input = card.querySelector('input[type="range"]');
    input.value = '${value}';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return card.querySelector('.oc-value')?.textContent ?? '';
  })()`);

  // (1) NEGATIVE HALF: the mirrored freq range -300..300 (a770) - the slider
  // reaches the negative half, the readout renders it, and an apply writes
  // + reads back the negative offset.
  const freqMin = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] input[type="range"]')?.getAttribute('min')`);
  const freqMax = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] input[type="range"]')?.getAttribute('max')`);
  if (freqMin !== '-300' || freqMax !== '300') fail(`M4-B: freq slider range is '${freqMin}'..'${freqMax}' (expected -300..300 - the mirrored min)`);
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
  // (a770) - a -0.050 V apply writes + reads back through the clamp (the
  // finding-5b negative-volt e2e pin; M15 F4-fix: the exposed step is
  // 0.001, so -0.05 is on-grid). M16 (nit): the step + the 0.234 max
  // reachability are pinned below - the slider must actually reach +
  // display the real ceiling (the old 0.005 step maxed at 0.230).
  const setVoltSlider = (value) => js(`(() => {
    const card = document.querySelector('.oc-card[data-control="gpuVoltOffsetV"]');
    const input = card.querySelector('input[type="range"]');
    input.value = '${value}';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return card.querySelector('.oc-value')?.textContent ?? '';
  })()`);
  const voltMin = await js(`document.querySelector('.oc-card[data-control="gpuVoltOffsetV"] input[type="range"]')?.getAttribute('min')`);
  const voltMax = await js(`document.querySelector('.oc-card[data-control="gpuVoltOffsetV"] input[type="range"]')?.getAttribute('max')`);
  if (voltMin !== '-0.234' || voltMax !== '0.234') fail(`M4-B: volt slider range is '${voltMin}'..'${voltMax}' (expected -0.234..0.234 - the mirrored min)`);
  // M15 F4-fix / M16 (nit 9a): the slider's step attribute is the pinned
  // 0.001 grid - the old driver-reported 0.005 put the 0.234 ceiling
  // OFF-GRID (the slider maxed at 0.230). The step + the reachability of
  // the REAL ceiling are the regression pins here.
  const voltStep = await js(`document.querySelector('.oc-card[data-control="gpuVoltOffsetV"] input[type="range"]')?.getAttribute('step')`);
  if (voltStep !== '0.001') fail(`M16: the volt slider step is '${voltStep}' (expected 0.001 - the M15 F4-fix grid for the 0.234 ceiling)`);
  const voltMaxReadout = await setVoltSlider(0.234);
  if (voltMaxReadout.trim() !== '0.234 V') fail(`M16: the volt slider cannot reach/display the real ceiling: '${voltMaxReadout}' (expected '0.234 V' - the M15 F4-fix reachability pin)`);
  await clearToasts();
  await clickApply();
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M16: the 0.234 V max apply success toast missing');
  const maxVoltState = await js(`window.arcPower.getCurrentSettings(0)`);
  if (Math.abs(maxVoltState.gpuVoltOffsetV - 0.234) > 1e-6) fail(`M16: the 0.234 V max apply did not stick: ${maxVoltState.gpuVoltOffsetV} (the 0.001 step must NOT re-snap it to 0.230)`);
  step('m16-volt-max', `M16: volt slider step '${voltStep}', max '${voltMax}' reachable -> readout '${voltMaxReadout.trim()}', apply -> read-back ${maxVoltState.gpuVoltOffsetV} V (the 0.234 ceiling survives the clamp)`);
  await clearToasts();
  const voltReadout = await setVoltSlider(-0.05);
  if (voltReadout.trim() !== '-0.050 V') fail(`M4-B: volt slider readout is '${voltReadout}' (expected '-0.050 V' - 3-decimal volt format)`);
  if (await floatingHidden()) fail('M4-B: floating Apply did not appear for the negative volt move');
  await clearToasts();
  await clickApply();
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4-B: negative volt apply success toast missing');
  const negVoltState = await js(`window.arcPower.getCurrentSettings(0)`);
  if (Math.abs(negVoltState.gpuVoltOffsetV + 0.05) > 1e-6) fail(`M4-B: negative volt apply did not stick: ${negVoltState.gpuVoltOffsetV}`);
  step('m4b-negative-volt', `M4-B: volt range ${voltMin}..${voltMax} V, slider -0.05 -> readout '${voltReadout.trim()}', apply -> read-back ${negVoltState.gpuVoltOffsetV} V`);
  await clearToasts();

  // (2) M17e (Run B): the Offset|Lock toggle round trip - the M4-B
  // Offset/Clock toggle DIED with the Clock mode (the pure/clock.ts
  // helpers were removed; the offset presentation is the ONLY freq
  // presentation). The toggle is Offset|Lock; Lock mode renders the
  // gpuLock editor INSIDE the freq card; the mode switch resets the other
  // side IN THE DRAFT; the lock apply is the ATOMIC payload (the offsets
  // zero ride along); the offset apply carries the (0,0) unlock; the
  // floating apply is FORCE-HIDDEN in Lock mode; the editor bounds come
  // from caps.lockRange. gpuLock-capable sessions (a770/a750/acer-a750)
  // run the full round trip; b580-like sessions (no gpuLock control) pin
  // the NO-TOGGLE offset card.
  if (gpuLockUi) {
    if (!(await js(`!!document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .oc-lock-mode-toggle')`))) {
      fail('M17e: the Offset|Lock segmented toggle is missing on the freq card (gpuLock-capable session)');
    }
    const lockTitle = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .card-title')?.textContent ?? ''`);
    if (lockTitle.trim() !== 'Core clock') fail(`M17e: the freq card title is '${lockTitle}' (must stay 'Core clock' in the default Offset mode - M17f: it flips to 'GPU Lock' in Lock mode)`);
    // The editor is NESTED inside the freq card (the M17d standalone card
    // is folded in) + HIDDEN in Offset mode.
    const editorNested = await js(`!!document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .gpu-lock-editor')`);
    if (!editorNested) fail('M17e: the gpuLock editor is not nested inside the freq card (it must render INSIDE the card in Lock mode)');
    const editorHiddenOffset = await js(`document.querySelector('.gpu-lock-editor')?.hidden === true`);
    if (!editorHiddenOffset) fail('M17e: the lock editor must be HIDDEN in Offset mode (hidden attribute)');
    // The lockRange bounds ride the inputs (the A770's probe-pinned
    // caps.lockRange row - the M17f fold: voltMax 1.1 V live-verified
    // 2026-08-13, 1150+ refused 0x44000002; freqMax 5000 documented, >=
    // 3000 live-verified).
    const lockVoltMax = await js(`document.querySelector('.gpu-lock-editor input[data-lock-field="voltageV"]')?.getAttribute('max')`);
    const lockFreqMax = await js(`document.querySelector('.gpu-lock-editor input[data-lock-field="freqMhz"]')?.getAttribute('max')`);
    if (lockVoltMax !== '1.1' || lockFreqMax !== '5000') {
      fail(`M17e: the lock editor bounds are '${lockVoltMax}' V / '${lockFreqMax}' MHz (expected the caps.lockRange 1.1 / 5000 - the A770 probe-pinned row)`);
    }
    // Switch to Lock: the offsets draft 0 (the mutual-exclusion rule) + the
    // editor prefills from the driver lock (the a770 mock starts unlocked ->
    // (0,0)) + the editor appears + the floating apply is FORCE-HIDDEN.
    // M17f (the USER ADDITION - the card-REPLACEMENT toggle): Lock mode
    // REPLACES the card content - the Core-Offset SLIDER row + the WHOLE
    // separate Voltage-Offset CARD are NOT DISPLAYED AT ALL, the card TITLE
    // flips to 'GPU Lock', and the description is the pinned short text.
    // The M17e 0-draft pin DIED with the replacement (the volt card's
    // .oc-value no longer exists in Lock mode) - the new pins assert the
    // absence + the title flip + the description instead (the draft-0
    // semantics survive via the atomic payloads below: the lock apply lands
    // with the offsets 0).
    await js(`Array.from(document.querySelectorAll('.oc-lock-mode-btn')).find((b) => b.textContent.trim() === 'Lock')?.click()`);
    await sleep(150);
    const lockVoltDraft = await js(`document.querySelector('.gpu-lock-editor input[data-lock-field="voltageV"]')?.value`);
    const lockFreqDraft = await js(`document.querySelector('.gpu-lock-editor input[data-lock-field="freqMhz"]')?.value`);
    if (lockVoltDraft !== '0' || lockFreqDraft !== '0') {
      fail(`M17e: the Lock-mode prefill is '${lockVoltDraft}' V / '${lockFreqDraft}' MHz (expected 0 / 0 - the driver lock (0,0) or the (0,0) fallback)`);
    }
    const voltCardHiddenLock = await js(`document.querySelector('.oc-card[data-control="gpuVoltOffsetV"]')?.hidden === true`);
    if (!voltCardHiddenLock) fail('M17f: the Voltage offset card must NOT be displayed in Lock mode (the card-replacement toggle)');
    const freqSliderHiddenLock = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .oc-slider-row')?.hidden === true`);
    if (!freqSliderHiddenLock) fail('M17f: the Core-Offset slider must NOT be displayed in Lock mode (the card-replacement toggle)');
    const lockTitleFlipped = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .card-title')?.textContent ?? ''`);
    if (lockTitleFlipped.trim() !== 'GPU Lock') fail(`M17f: the card title must flip to 'GPU Lock' in Lock mode (got '${lockTitleFlipped}')`);
    const lockNoteText = await js(`document.querySelector('.gpu-lock-editor .card-note')?.textContent ?? ''`);
    if (lockNoteText.trim() !== 'Fix the GPU to one voltage and frequency. 0 V / 0 MHz returns to automatic. Setting a lock clears the core and voltage offsets; setting offsets clears the lock.') {
      fail(`M17f: the lock description is '${lockNoteText}' (expected the pinned short text)`);
    }
    // M17f (the round-5 fold - the user addition): the lock editor
    // DISPLAYS ITS RANGE - the caps.lockRange live bounds rendered on the
    // card (the .oc-range meta-line pattern; the inputs' max attrs bind the
    // same range - pinned above; the documented fallback text renders when
    // the range is absent, the honest 'Range: -' when none resolves - both
    // pinned at the pure level).
    const lockRangeText = await js(`document.querySelector('.gpu-lock-editor .gpu-lock-range')?.textContent ?? ''`);
    if (lockRangeText !== 'Range: 0 - 1.1 V / 0 - 5000 MHz') {
      fail(`M17f: the lock range line is '${lockRangeText}' (expected 'Range: 0 - 1.1 V / 0 - 5000 MHz' - the caps.lockRange live bounds on the a770 mock)`);
    }
    const editorHiddenLock = await js(`document.querySelector('.gpu-lock-editor')?.hidden === false`);
    if (!editorHiddenLock) fail('M17e: the lock editor must be VISIBLE in Lock mode');
    if (!(await floatingHidden())) fail('M17e: the floating Apply must be FORCE-HIDDEN in Lock mode');
    // M17f (the DYING-pin flip): the M17e slider-drag pin DIED - the offset
    // slider no longer EXISTS in Lock mode (the card-replacement toggle), so
    // a drag cannot re-enable the floating button. The replacement asserts
    // the slider row stays hidden + the floating apply stays force-hidden.
    if (await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .oc-slider-row')?.hidden === false`)) {
      fail('M17f: the offset slider row must stay hidden in Lock mode');
    }
    if (!(await floatingHidden())) fail('M17f: the floating Apply must stay FORCE-HIDDEN in Lock mode (no slider exists to dirty it)');
    // M17f (step-4 N1): a FULL RE-RENDER mid-Lock-mode must rebuild the
    // Lock presentation from the CURRENT lockMode state - the featureset
    // swap round trip is the mock's deterministic caps change (the swap
    // re-renders the whole page - the OC-mode toggle / device switch /
    // swap class of re-render). The old bug: resetPageState zeroed
    // lockMode, so the re-render left the mixed editor+slider surface
    // with the reverted 'Core clock' title.
    const lockSwapTo = (id) => js(`(() => {
      const s = document.querySelector('.featureset-select');
      s.value = '${id}';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await lockSwapTo('a750');
    if (!(await waitFor(win, `(document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value')?.textContent ?? '').trim() === '190 W'`, 8000))) {
      fail(`M17f (N1): the swap to a750 did not re-render (PL readout '${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value')?.textContent ?? ''`)}' - expected '190 W')`);
    }
    await lockSwapTo('a770');
    if (!(await waitFor(win, `(document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value')?.textContent ?? '').trim() === '210 W'`, 8000))) {
      fail(`M17f (N1): the swap back to a770 did not re-render (PL readout '${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value')?.textContent ?? ''`)}' - expected '210 W')`);
    }
    // The re-rendered surface must be the FULL Lock presentation: the
    // editor visible + the volt card + the offset slider hidden + the
    // 'GPU Lock' title (the pre-fix state mixed the editor with the
    // sliders and reverted the title).
    if (!(await waitFor(win, `(document.querySelector('.gpu-lock-editor')?.hidden === false) && (document.querySelector('.oc-card[data-control="gpuVoltOffsetV"]')?.hidden === true) && (document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .oc-slider-row')?.hidden === true) && ((document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .card-title')?.textContent ?? '').trim() === 'GPU Lock')`, 5000))) {
      fail(`M17f (N1): the full re-render mid-Lock-mode did not rebuild the Lock presentation (editorHidden=${await js(`document.querySelector('.gpu-lock-editor')?.hidden`)} voltCardHidden=${await js(`document.querySelector('.oc-card[data-control="gpuVoltOffsetV"]')?.hidden`)} sliderHidden=${await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .oc-slider-row')?.hidden`)} title='${await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .card-title')?.textContent ?? ''`)}')`);
    }
    const relockDraft = await js(`document.querySelector('.gpu-lock-editor input[data-lock-field="voltageV"]')?.value`);
    if (relockDraft !== '0') fail(`M17f (N1): the re-render prefill is '${relockDraft}' V (expected '0' - the driver lock (0,0) prefill on the re-rendered editor)`);
    if (!(await floatingHidden())) fail('M17f (N1): the floating Apply must stay FORCE-HIDDEN after the re-render (still Lock mode)');
    step('m17f-lock-render', `M17f (N1): a full re-render mid-Lock-mode (a750 swap round trip) keeps the Lock presentation - editor visible, volt card + offset slider hidden, title 'GPU Lock', prefill (0,0), floating apply force-hidden`);
    await sleep(100);
    // The lock editor's DIRTY semantics: the Apply enables only when the
    // typed pair differs from the driver lock (the pristine (0,0) prefill
    // matches the unlocked driver -> disabled).
    const pristineDisabled = await js(`Array.from(document.querySelectorAll('.gpu-lock-actions button')).find((b) => (b.textContent ?? '').trim() === 'Apply')?.disabled === true`);
    if (!pristineDisabled) fail('M17e: the lock editor Apply must be DISABLED while the typed pair equals the driver lock (pristine)');
    // Type a pair (1.0 V / 2600 MHz) + apply through the editor's Apply -
    // the ATOMIC LOCK payload { gpuLock, gpuFreqOffsetMhz: 0,
    // gpuVoltOffsetV: 0 } - the driver state shows the lock AND the
    // offsets 0.
    await js(`(() => {
      const card = document.querySelector('.gpu-lock-editor');
      if (!card) return;
      const v = card.querySelector('input[data-lock-field="voltageV"]');
      const f = card.querySelector('input[data-lock-field="freqMhz"]');
      v.value = '1.0';
      f.value = '2600';
      v.dispatchEvent(new Event('input', { bubbles: true }));
      f.dispatchEvent(new Event('input', { bubbles: true }));
      Array.from(card.querySelectorAll('.gpu-lock-actions button')).find((b) => (b.textContent ?? '').trim() === 'Apply').click();
    })()`);
    if (!(await waitFor(win, `window.arcPower.getCurrentSettings(0).then((s) => !!(s.gpuLock && s.gpuLock.voltageV === 1 && s.gpuLock.freqMhz === 2600 && s.gpuFreqOffsetMhz === 0 && s.gpuVoltOffsetV === 0))`, 8000))) {
      fail(`M17e: the atomic LOCK apply did not land (${JSON.stringify((await js(`window.arcPower.getCurrentSettings(0)`)).gpuLock)} - the driver must show the lock + the offsets 0)`);
    }
    const lockReadoutM17e = await js(`document.querySelector('.gpu-lock-current')?.textContent ?? ''`);
    if (!lockReadoutM17e.includes('1 V / 2600 MHz')) fail(`M17e: the lock read-out is '${lockReadoutM17e}' (expected 'Lock: 1 V / 2600 MHz')`);
    await clearToasts();
    // An out-of-range typed pair clamps to caps.lockRange (the renderer
    // clamp mirror + the backend clamp - 9.9 V -> 1.1 V, the A770's
    // probe-pinned voltMax; the (0,0) unlock stays reachable via the S2
    // bypass).
    await js(`(() => {
      const v = document.querySelector('.gpu-lock-editor input[data-lock-field="voltageV"]');
      v.value = '9.9';
      v.dispatchEvent(new Event('input', { bubbles: true }));
      Array.from(document.querySelectorAll('.gpu-lock-actions button')).find((b) => (b.textContent ?? '').trim() === 'Apply').click();
    })()`);
    if (!(await waitFor(win, `window.arcPower.getCurrentSettings(0).then((s) => !!(s.gpuLock && s.gpuLock.voltageV === 1.1 && s.gpuLock.freqMhz === 2600))`, 8000))) {
      fail(`M17e: the lockRange clamp did not land (${JSON.stringify((await js(`window.arcPower.getCurrentSettings(0)`)).gpuLock)} - expected the 1.1 V voltMax)`);
    }
    // M17e (round-2 N2): the editor inputs re-sync to the APPLIED pair -
    // the typed 9.9 must never lie next to the honest read-out (the driver
    // received 1.1 V), and the re-synced editor reads pristine (the Apply
    // button disables again - typed == applied).
    const lockVoltResync = await js(`document.querySelector('.gpu-lock-editor input[data-lock-field="voltageV"]')?.value`);
    if (lockVoltResync !== '1.1') {
      fail(`M17e (N2): after the clamped apply the voltage input must re-sync to the APPLIED pair (got '${lockVoltResync}', expected '1.1' - the typed 9.9 must never lie next to the honest read-out)`);
    }
    const lockFreqResync = await js(`document.querySelector('.gpu-lock-editor input[data-lock-field="freqMhz"]')?.value`);
    if (lockFreqResync !== '2600') {
      fail(`M17e (N2): after the clamped apply the freq input must re-sync to the applied 2600 (got '${lockFreqResync}')`);
    }
    const resyncPristine = await js(`Array.from(document.querySelectorAll('.gpu-lock-actions button')).find((b) => (b.textContent ?? '').trim() === 'Apply')?.disabled === true`);
    if (!resyncPristine) fail('M17e (N2): after the re-sync the editor must read pristine (the Apply button disabled - typed == applied)');
    await clearToasts();
    // Switch back to Offset: the lock DRAFTS (0,0) (never applied - the
    // driver still holds the lock) + the editor hides + the floating apply
    // stays hidden (the offsets are 0).
    await js(`Array.from(document.querySelectorAll('.oc-lock-mode-btn')).find((b) => b.textContent.trim() === 'Offset')?.click()`);
    await sleep(150);
    const lockVoltBack = await js(`document.querySelector('.gpu-lock-editor input[data-lock-field="voltageV"]')?.value`);
    const lockFreqBack = await js(`document.querySelector('.gpu-lock-editor input[data-lock-field="freqMhz"]')?.value`);
    if (lockVoltBack !== '0' || lockFreqBack !== '0') {
      fail(`M17e: switching back to Offset must draft the lock (0,0) (got '${lockVoltBack}' / '${lockFreqBack}')`);
    }
    const lockStillHeld = await js(`window.arcPower.getCurrentSettings(0).then((s) => s.gpuLock && s.gpuLock.voltageV === 1.1 && s.gpuLock.freqMhz === 2600)`);
    if (!lockStillHeld) fail('M17e: the Offset-mode switch must DRAFT the (0,0) pair - never apply it (the driver lock must stay)');
    if (await js(`document.querySelector('.gpu-lock-editor')?.hidden === false`)) fail('M17e: the lock editor must hide again in Offset mode');
    // M17f: the card-replacement toggle's flip-back - the Offset mode
    // RESTORES the card content: the title back to 'Core clock' (lowercase
    // c - CONTROL_LABELS, never changed), the offset slider row + the
    // voltage-offset card displayed again.
    const offsetTitleRestored = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .card-title')?.textContent ?? ''`);
    if (offsetTitleRestored.trim() !== 'Core clock') fail(`M17f: the card title must flip back to 'Core clock' in Offset mode (got '${offsetTitleRestored}')`);
    if (await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .oc-slider-row')?.hidden === true`)) {
      fail('M17f: the offset slider row must be displayed again in Offset mode');
    }
    if (await js(`document.querySelector('.oc-card[data-control="gpuVoltOffsetV"]')?.hidden === true`)) {
      fail('M17f: the Voltage offset card must be displayed again in Offset mode');
    }
    if (!(await floatingHidden())) fail('M17e: the floating Apply must stay hidden after the mode flip back (the offsets drafted 0 - nothing dirty)');
    // The ATOMIC UNLOCK: drag the freq offset to 100 while the driver
    // still holds the lock -> the per-card chip apply carries the (0,0)
    // unlock -> the driver lock clears + the offset lands.
    await setFreqSlider(100);
    await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .oc-chip-apply')?.click()`);
    if (!(await waitFor(win, `window.arcPower.getCurrentSettings(0).then((s) => s.gpuLock && s.gpuLock.voltageV === 0 && s.gpuLock.freqMhz === 0 && s.gpuFreqOffsetMhz === 100)`, 8000))) {
      fail(`M17e: the atomic UNLOCK apply did not land (${JSON.stringify((await js(`window.arcPower.getCurrentSettings(0)`)).gpuLock)} - the offset apply while locked must clear the driver lock first)`);
    }
    step('m17e-lock-toggle', `M17e/M17f: Offset|Lock toggle - Lock drafts the offsets 0 + prefills (0,0) + REPLACES the card content (the offset slider row + the Voltage offset card NOT displayed - the card-replacement toggle) + flips the title to 'GPU Lock' + shows the new pinned description + the range line reads the caps.lockRange bounds ('Range: 0 - 1.1 V / 0 - 5000 MHz') + force-hides the floating apply; the atomic LOCK lands (1 V / 2600 MHz + the offsets 0); the 9.9 V clamp lands (1.1 V); Offset drafts (0,0) without applying + restores the 'Core clock' title + the volt card + the slider; the atomic UNLOCK lands (offset 100 + the driver lock cleared); bounds ${lockVoltMax} V / ${lockFreqMax} MHz from caps.lockRange`);
    await clearToasts();
  } else {
    // b580-like sessions (no gpuLock control): the offset card renders with
    // NO toggle + NO editor (the no-lock shape - the plan's b580 pin).
    if (await js(`!!document.querySelector('.oc-lock-mode-toggle')`)) {
      fail('M17e: the Offset|Lock toggle is rendered on a session without gpuLock support (must be offset-only)');
    }
    if (await js(`!!document.querySelector('.gpu-lock-editor')`)) {
      fail('M17e: the gpuLock editor is rendered on a session without gpuLock support');
    }
    if (await js(`!!document.querySelector('.gpu-lock-range')`)) {
      fail('M17f: the lock range line is rendered on a session without gpuLock support (no lock editor -> no range line - the honest absence)');
    }
    step('m17e-lock-toggle', 'M17e: no gpuLock support -> the freq card renders the OFFSET card with NO Offset|Lock toggle + NO lock editor + NO lock range line (the b580 shape)');
  }
  await clearToasts();

  // (3) M4J (D) + clarification: the Advanced section renders ONLY on
  // vramFreqOffset sessions and holds the VRAM clock editor ONLY (the full
  // round trip lives in the b580 variant). On the Alchemist surface (a770/
  // arc-igpu/pro-b50: no vramFreqOffset) the section is GONE - the gpuLock
  // editor + the vfCurve/vramVoltOffset rows are removed per the user
  // (profiles can still apply those values via the state machinery -
  // documented). The OC-mode pill is NOT affected (renders everywhere).
  if (vramFreqUi) {
    if (await js(`!!document.querySelector('.advanced-card')`) === false) {
      fail('M4J (D): the Advanced section is missing on a vramFreqOffset session');
    }
    if (await js(`!!document.querySelector('.gpu-lock-editor')`)) {
      fail('M4J (D): the gpuLock editor is still rendered (removed - the section holds the VRAM editor only)');
    }
    if (await js(`!!document.querySelector('.vram-editor-card')`) === false) {
      fail('M4J (D): the VRAM clock editor card is missing from the Advanced section');
    }
    if (await js(`!!document.querySelector('.expert-row')`)) {
      fail('M4J (D): the expert rows are still rendered (the vfCurve/vramVoltOffset rows are removed)');
    }
    step('m4j-advanced', 'M4J (D): Advanced section = the VRAM clock editor ONLY (no expert rows, no gpuLock editor)');
  } else {
    if (await js(`!!document.querySelector('.advanced-card')`)) {
      fail('M4J (D): the Advanced section is still rendered on a device without vramFreqOffset (Alchemist)');
    }
    // M17d (Run D)/M17e (Run B - the flip): the gpuLock editor lives
    // INSIDE the freq card (the M17d STANDALONE card is folded in - NOT
    // the dead M4-J section). The M4-J editor-absence assert flips ONLY
    // where caps.controls.gpuLock is true - the a770/a750/acer-a750
    // sessions render the nested editor now; arc-igpu/pro-b50 (no gpuLock
    // control) stay absent (their absence is by construction - the editor
    // is caps.controls.gpuLock-gated; the b580 absence pins stay).
    if (gpuLockUi) {
      if (await js(`!!document.querySelector('.gpu-lock-editor')`) === false) {
        fail('M17d/M17e: the gpuLock editor is missing on a gpuLock-capable session');
      }
    } else {
      if (await js(`!!document.querySelector('.gpu-lock-editor')`)) {
        fail('M17d/M17e: the gpuLock editor is rendered without caps.controls.gpuLock');
      }
    }
    step('m4j-advanced-absent', 'M4J (D) + M17d (Run D) + M17e (Run B): the Advanced section is ABSENT on Alchemist (the OC-mode pill stays); the gpuLock editor renders NESTED inside the freq card on gpuLock-capable sessions only');
  }
  await clearToasts();

  // --- M17d (Run D)/M17e (Run B): the gpuLock editor round trip - the
  // --- editor is now NESTED inside the freq card's Lock mode (the M17d
  // --- standalone card is folded in - the .gpu-lock-editor +
  // --- .gpu-lock-actions selectors survive the move). Type a pair, apply,
  // --- verify the mock lock state + the read-out, reset to dynamic (0,0),
  // --- verify the state cleared. -----------------------------------------
  if (gpuLockUi) {
    const lockInitial = await js(`document.querySelector('.gpu-lock-current')?.textContent ?? ''`);
    if (!lockInitial.includes('Dynamic (unlocked)')) {
      fail(`M17d: the lock read-out starts at '${lockInitial}' (expected 'Lock: Dynamic (unlocked)' - the a770 mock starts unlocked)`);
    }
    // Type a pair (1.0 V / 2600 MHz) and apply through the editor's Apply
    // button - the real apply-settings channel with the gpuLock control.
    // M17e: the input events are DISPATCHED (the editor's dirty semantics
    // enable the Apply only when the typed pair differs from the driver
    // lock - a raw .value set would leave the button disabled).
    await js(`(() => {
      const card = document.querySelector('.gpu-lock-editor');
      if (!card) return;
      const v = card.querySelector('input[data-lock-field="voltageV"]');
      const f = card.querySelector('input[data-lock-field="freqMhz"]');
      v.value = '1.0';
      f.value = '2600';
      v.dispatchEvent(new Event('input', { bubbles: true }));
      f.dispatchEvent(new Event('input', { bubbles: true }));
      Array.from(card.querySelectorAll('.gpu-lock-actions button')).find((b) => (b.textContent ?? '').trim() === 'Apply').click();
    })()`);
    if (!(await waitFor(win, `window.arcPower.getCurrentSettings(0).then((s) => !!(s.gpuLock && s.gpuLock.voltageV === 1 && s.gpuLock.freqMhz === 2600))`, 8000))) {
      fail(`M17d: the gpuLock apply did not land in the mock state (${JSON.stringify((await js(`window.arcPower.getCurrentSettings(0)`)).gpuLock)})`);
    }
    const lockReadout = await js(`document.querySelector('.gpu-lock-current')?.textContent ?? ''`);
    if (!lockReadout.includes('1 V / 2600 MHz')) {
      fail(`M17d: the lock read-out is '${lockReadout}' (expected 'Lock: 1 V / 2600 MHz' - the card shows the driver state)`);
    }
    await clearToasts();
    // Reset to Dynamic: the (0,0) unlock pair - apply it and verify the
    // mock state cleared + the read-out returns to Dynamic.
    await js(`(() => {
      const card = document.querySelector('.gpu-lock-editor');
      if (!card) return;
      Array.from(card.querySelectorAll('.gpu-lock-actions button')).find((b) => (b.textContent ?? '').trim() === 'Reset to Dynamic').click();
      Array.from(card.querySelectorAll('.gpu-lock-actions button')).find((b) => (b.textContent ?? '').trim() === 'Apply').click();
    })()`);
    if (!(await waitFor(win, `window.arcPower.getCurrentSettings(0).then((s) => !!(s.gpuLock && s.gpuLock.voltageV === 0 && s.gpuLock.freqMhz === 0))`, 8000))) {
      fail(`M17d: the reset-to-dynamic apply did not clear the mock lock state (${JSON.stringify((await js(`window.arcPower.getCurrentSettings(0)`)).gpuLock)})`);
    }
    const lockUnlocked = await js(`document.querySelector('.gpu-lock-current')?.textContent ?? ''`);
    if (!lockUnlocked.includes('Dynamic (unlocked)')) {
      fail(`M17d: the lock read-out is '${lockUnlocked}' after the reset (expected 'Dynamic (unlocked)')`);
    }
    step('m17d-gpulock', 'M17d (Run D): the Fixed Clock / Voltage Lock card - 1.0 V / 2600 MHz apply lands (mock state + read-out verified), Reset to Dynamic clears the lock (0,0)');
    await clearToasts();
  }

  // Restore: Offset mode + freq 0 + volt 0 - the later sections expect the
  // a770 baseline (the freq card must never be left in Lock mode, and the
  // volt slider must never be left in the negative half-plane). The M4-B
  // restore-Offset click DIES with the Offset/Clock toggle - the M17e
  // Offset|Lock toggle's Offset button restores the mode instead. M17e:
  // the baseline may ALREADY be clean (the atomic lock zeroes the offsets
  // + the atomic unlock rides the payloads) - the floating apply is
  // clicked only when visible (a hidden-button click would be a no-op).
  await js(`Array.from(document.querySelectorAll('.oc-card[data-control="gpuFreqOffsetMhz"] .oc-lock-mode-btn')).find((b) => b.textContent.trim() === 'Offset')?.click()`);
  await sleep(150);
  await setVoltSlider(0);
  await setFreqSlider(0);
  if (!(await floatingHidden())) {
    await clickApply();
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4-B: freq/volt baseline restore did not apply');
    await clearToasts();
  }
  const freqRestored = await js(`window.arcPower.getCurrentSettings(0)`);
  if (Math.abs(freqRestored.gpuFreqOffsetMhz) > 1e-6) fail(`M4-B: freq baseline not restored: ${freqRestored.gpuFreqOffsetMhz}`);
  if (Math.abs(freqRestored.gpuVoltOffsetV) > 1e-6) fail(`M4-B: volt baseline not restored: ${freqRestored.gpuVoltOffsetV}`);
  await clearToasts();
  step('m4b-restore', `M4-B/M17e: back to Offset mode, freq baseline restored (${freqRestored.gpuFreqOffsetMhz} MHz), volt baseline restored (${freqRestored.gpuVoltOffsetV} V), gpuLock unlocked`);

  // --- 5c. M3-C-D/E extended + stock variants. ------------------------------
  // RID_MOCK_EXTENDED_RANGES=1 (mock default OC mode = advanced): full slider
  // range (315 W / 115 C - M17d FLIP (round-3 N3): the a770's ADVANCED shape
  // restores the KMD ceiling 115, the M17c listed-row 90 cap is removed;
  // the fixture's raw 115 passes the finalize now), the extended apply
  // SKIPS the per-apply confirm
  // (the mode-enable confirm already warned - double-dialog decision);
  // optional RID_MOCK_WORKER_APPLY=1 adds the elevation toast on top.
  // RID_MOCK_STOCK_MODE=1: stock mode - sliders pinned to the standard
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

    // The extended ranges are exposed: PL slider max 315 W; the TL slider
    // max is the M17d restored 115 C (the a770 ADVANCED shape - the
    // app-verified KMD ceiling; the M17c listed-row 90 cap is removed).
    const plMax = await js(`document.querySelector('.oc-card[data-control="powerLimitW"] input[type="range"]')?.getAttribute('max')`);
    if (plMax !== '315') fail(`M3-C-D: power slider max is '${plMax}' (expected 315 - live-verified ceiling)`);
    const tlMax = await js(`document.querySelector('.oc-card[data-control="tempLimitC"] input[type="range"]')?.getAttribute('max')`);
    if (tlMax !== '115') fail(`M3-C-D: temp slider max is '${tlMax}' (expected 115 - M17d: the restored a770 advanced TL)`);
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
    // M17f: the PL2 read-out follows the extended apply too (the fixture
    // mirror answers the fresh 300 W for both domains).
    if (!(await waitFor(win, `(document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? '').trim() === 'PL1 300 W / PL2 300 W'`, 5000))) {
      fail(`M17f: the PL2 read-out did not refresh after the EXTENDED apply: '${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? ''`)}' (expected 'PL1 300 W / PL2 300 W')`);
    }
    step('extended-apply', `extended apply (300 W) applied with NO per-apply confirm, read-back ${extendedState.powerLimitW} W, driver readout '${extDriver.trim()}', PL2 read-out '${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? ''`)}'`);
    await clearToasts();

    // Restore the standard baseline for the later steps.
    await setPlSlider(210);
    await clickApply();
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('extended baseline restore (210 W) did not apply');
    const baseline = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(baseline.powerLimitW - 210) > 1e-6) fail(`extended baseline is not 210 W: ${baseline.powerLimitW}`);
    // M17f: the PL2 read-out follows the restore (back to the 210 W pair).
    if (!(await waitFor(win, `(document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? '').trim() === 'PL1 210 W / PL2 210 W'`, 5000))) {
      fail(`M17f: the PL2 read-out did not follow the baseline restore: '${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? ''`)}' (expected 'PL1 210 W / PL2 210 W')`);
    }
    await clearToasts();
    step('extended-restore', `extended baseline restored to 210 W (the PL2 read-out follows: '${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? ''`)}')`);
  } else if (stockMode) {
    // M3-C-E stock variant: the sliders stay within the standard limits and
    // a DIRECT above-limit request REFUSES with the mode message - never
    // clamps, never a confirm dialog (the mock default is advanced; this
    // variant flipped it to stock via RID_MOCK_STOCK_MODE=1).
    // M17d (Run C, item 0c + the 2026-08-12 probe verdicts): the a750/acer
    // stock-mode pins - the STOCK shape's per-AIB PL ceilings (a750/ASRock
    // 216 W, acer-a750 216 W - the probe-pinned Acer stock: the DriverStore
    // props max 216, the 235 BiFrost documented row REFUTED as a stock
    // value on the Acer card/driver; the a770-default stays 252) + a direct
    // above-ceiling apply REFUSES with the mode message (the round-2 S8
    // class: the per-control toast shows the mode text, NEVER the generic
    // 'clamps' text - item 0b). The featureset id is read HERE (the
    // bootWaiverStep-scoped fsId is not visible in runUiVerify).
    const verifyFsId = process.env.RID_MOCK_FEATURESET;
    const isA750Fs = verifyFsId === 'a750' || verifyFsId === 'acer-a750';
    const stockPlMax = isA750Fs ? '216' : '252';
    const plMax = await js(`document.querySelector('.oc-card[data-control="powerLimitW"] input[type="range"]')?.getAttribute('max')`);
    if (plMax !== stockPlMax) fail(`M3-C-E stock: power slider max is '${plMax}' (expected ${stockPlMax} - ${isA750Fs ? (verifyFsId === 'acer-a750' ? 'the probe-pinned Acer stock 216 W (the 2026-08-12 verdict)' : 'the a750 stock 216 W (the ASRock ceiling)') : 'standard limit'})`);
    const tlMax = await js(`document.querySelector('.oc-card[data-control="tempLimitC"] input[type="range"]')?.getAttribute('max')`);
    if (tlMax !== '90') fail(`M3-C-E stock: temp slider max is '${tlMax}' (expected 90)`);
    const stockBtn = await js(`Array.from(document.querySelectorAll('.oc-mode-btn')).find((b) => b.textContent.trim() === 'Stock')?.classList.contains('active')`);
    if (!stockBtn) fail('M3-C-E: the OC-mode toggle does not show Stock active');
    if (await js(`window.arcPower.getCapabilities(0).then((c) => c.extendedRanges === true)`)) {
      fail('M3-C-E stock: getCapabilities still reports extendedRanges in stock mode');
    }
    step('stock-ranges', `stock mode: PL slider max ${plMax} W, TL slider max ${tlMax} C, no extendedRanges flag`);

    // A direct above-ceiling apply (bypasses the slider - the UI cannot
    // produce it) must REFUSE with the mode message, never clamp and never
    // show a confirm dialog. M17d (item 0c + the 2026-08-12 verdicts): the
    // a750/acer pins - a value one W above the per-AIB stock ceiling
    // (217 on the a750 AND the acer - both stock caps are the probe-pinned
    // 216 / 300 on the a770-default).
    const refusalW = isA750Fs ? 217 : 300;
    const refusal = await js(`window.arcPower.applySettings(0, { powerLimitW: ${refusalW} })`);
    if (refusal.result.ok !== false) fail(`M3-C-E stock: a ${refusalW} W apply in stock mode did not refuse`);
    const per = refusal.result.perControl.powerLimitW;
    if (!per || per.ok !== false) fail('M3-C-E stock: the refusal is not per-control: ' + JSON.stringify(refusal.result.perControl));
    if (!/Advanced OC Mode/.test(per.message ?? '')) fail(`M3-C-E stock: refusal message is '${per?.message}' (expected the mode message)`);
    // M17d (item 0b): the TOAST contract - a gate refusal's per-control
    // MESSAGE wins over the errorCode mapping (the shared applyFailureText
    // preference - the 'clamps' lie never surfaces for a refusal). The OC
    // slider UI is gate-bounded by construction (a gate refusal cannot fire
    // from the OC page - the toast path for it is unit-pinned in
    // pure-errors.test.ts), and the MAPPED-text fallback for a
    // driver-shaped out-of-range is pinned end-to-end by the fan-fail-toast
    // step. The refusal envelope above carries the gate message itself.
    const stateAfter = await js(`window.arcPower.getCurrentSettings(0)`);
    const stockBaseline = isA750Fs ? 190 : 210;
    if (Math.abs(stateAfter.powerLimitW - stockBaseline) > 1e-6) fail(`M3-C-E stock: the refusal changed the device state: ${stateAfter.powerLimitW} (must stay ${stockBaseline})`);
    if (await js(`!!document.querySelector('.modal')`)) fail('M3-C-E stock: a dead-end confirm dialog appeared (refusal + toast only)');
    step('stock-refusal', `stock mode: ${refusalW} W refused with the mode message (the per-control message - never the 'clamps' errorCode mapping - the applyFailureText-pinned toast contract), device untouched at ${stockBaseline} W, no dialog`);
    await clearToasts();
  }

  // --- M4-B: the Advanced OC Mode warning is a ONCE-only gate -------
  // Shown ONLY on the first Stock->Advanced toggle, persisted on acceptance,
  // never re-asked on a later boot. Two flows:
  //   - stock-boot session (warning unaccepted): first Advanced click shows
  //     the dialog; Cancel keeps stock; the next click shows it AGAIN;
  //     Enable flips the mode AND persists; a later Stock->Advanced round
  //     trip shows NO dialog (the persistence is the regression pin).
  //   - RID_MOCK_ADVANCED_ACCEPTED=1 (boot-persisted acceptance): a
  //     Stock->Advanced toggle shows NO dialog at all - the "saved onto
  //     next boot" case.
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
    // toggle must skip the warning entirely - the "saved onto the next
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
  // M17c/M17d: the a750 + the Acer AIB variant joined the distribution
  // (6 options).
  if (fsOptions.length !== 6) fail(`M2D: dropdown lists ${fsOptions.length} featuresets (expected 6)`);
  for (const want of ['a750', 'a770', 'acer-a750', 'b580', 'pro-b50', 'arc-igpu']) {
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
  // M4-B/M4J (D)/M17e: no gpuLock editor anywhere on the b580 surface (no
  // gpuLock control -> the freq card has NO Offset|Lock toggle + NO nested
  // editor) - and on the b580 swap the Advanced section holds the VRAM
  // clock editor (vramFreqOffset native there).
  if (await js(`!!document.querySelector('.gpu-lock-editor')`)) {
    fail('M17e: the gpuLock editor is still rendered on the b580 surface (no gpuLock control - the editor must be absent)');
  }
  if (await js(`!!document.querySelector('.gpu-lock-range')`)) {
    fail('M17f: the lock range line is still rendered on the b580 surface (no gpuLock control - no lock editor -> no range line)');
  }
  if (await js(`!!document.querySelector('.oc-lock-mode-toggle')`)) {
    fail('M17e: the Offset|Lock toggle is rendered on the b580 surface (no gpuLock control - the offset card must have NO toggle)');
  }
  if (await js(`!!document.querySelector('.vram-editor-card')`) === false) {
    fail('M4J (D): the VRAM clock editor is missing on the b580 swap (vramFreqOffset native)');
  }
  step('fs-swap-b580', `swap -> b580: PL readout '100 %', percent units, gpuLock unsupported, vfCurve supported, VRAM clock editor present`);

  // M2D: the swap payload replaces the boot driver date - the HEALTH card's
  // driver row (the GPU card's Driver version row is REMOVED - M4-H) must
  // NOT pair 32.0.140.4109 with the a770 boot registry date (7-5-2026).
  const healthDriverRow = () => js(`document.querySelector('.health-card .health-row[data-row="driver"] .health-row-detail')?.textContent ?? ''`);
  await js(`location.hash = '#/dashboard'`);
  await sleep(250);
  const b580DriverRow = await healthDriverRow();
  if (!b580DriverRow.includes('32.0.140.4109') || b580DriverRow.includes('Jul')) {
    fail(`M2D swap: stale driver date on the b580 health row: '${b580DriverRow}'`);
  }
  step('fs-swap-b580-date', `swap -> b580: health driver row '${b580DriverRow.trim()}' (no stale date)`);
  await gotoOverclocking();

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
  // M4J (D): the Advanced section after the swap back to a770 follows the
  // DEVICE surface - the a770 featureset has no vramFreqOffset, so the
  // section (VRAM editor) drops; only a session that carries the control
  // natively (b580 featureset sessions) keeps it on the swapped-in a770.
  if (vramFreqUi) {
    if (await js(`!!document.querySelector('.advanced-card')`) === false) {
      fail('M4J (D): the Advanced section vanished after the swap back to a770 (the session overlay keeps vramFreqOffset)');
    }
    if (await js(`!!document.querySelector('.vram-editor-card')`) === false) {
      fail('M4J (D): the VRAM clock editor vanished after the swap back to a770 (the session overlay keeps vramFreqOffset)');
    }
  } else {
    if (await js(`!!document.querySelector('.advanced-card')`)) {
      fail('M4J (D): the Advanced section is still rendered after the swap back to a770 (Alchemist has no vramFreqOffset)');
    }
    if (await js(`!!document.querySelector('.vram-editor-card')`)) {
      fail('M4J (D): the VRAM clock editor is still rendered after the swap back to a770');
    }
  }
  // M2D: the a770 featureset's own registry date returns with the surface.
  await js(`location.hash = '#/dashboard'`);
  await sleep(250);
  const a770DriverRow = await healthDriverRow();
  if (!a770DriverRow.includes('Jul 05, 2026')) fail(`M2D swap-back: a770 driver date missing on the health row: '${a770DriverRow}'`);
  await gotoOverclocking();
  step('fs-swap-back', `swap back -> a770: PL readout '210 W', W units, waiver preserved, driver date 'Jul 05, 2026'`);

  // --- 6. fan editor (M4-D2: the Tuning page's "Fan Curve" sub-view) -------
  const fanReadonly = process.env.RID_MOCK_FAN_READONLY === '1';
  // M4-D2 (§8): the old '#/fan' hash redirects to the Tuning page with the
  // FAN sub-view active (router consumeFanViewRequest) - the pins below run
  // inside the sub-view, unchanged selectors.
  await js(`location.hash = '#/fan'`);
  await sleep(250);
  const fanViewActive = await js(`(() => {
    const b = Array.from(document.querySelectorAll('.tuning-view-btn')).find((x) => x.textContent.trim() === 'Fan Curve');
    return !!b && b.classList.contains('active');
  })()`);
  if (!fanViewActive) fail('M4-D2: the #/fan redirect did not activate the Fan Curve sub-view');
  const fanPageTitle = await js(`document.querySelector('.page-title')?.textContent ?? ''`);
  if (fanPageTitle.trim() !== 'Tuning') fail(`M4-D2: the #/fan redirect must land on the Tuning page (title is '${fanPageTitle}')`);
  // M4-H (A3): while the FAN view is active the OC-mode (Stock/Advanced)
  // column of the shared mode row is HIDDEN (a class on the row + CSS -
  // N6: applied on the INITIAL #/fan render too, not only in setView);
  // the View pill + the GPU selector stay.
  const fanModeRow = await js(`(() => {
    const row = document.querySelector('.oc-mode-row');
    if (!row) return 'no-row';
    const hasClass = row.classList.contains('fan-hides-oc-column');
    const stockVisible = Array.from(row.querySelectorAll('.oc-mode-btn')).some((b) => b.textContent.trim() === 'Stock' && b.offsetParent !== null);
    const viewVisible = Array.from(row.querySelectorAll('.tuning-view-btn')).some((b) => b.textContent.trim() === 'Fan Curve' && b.offsetParent !== null);
    return JSON.stringify({ hasClass, stockVisible, viewVisible });
  })()`);
  const fanRowState = JSON.parse(fanModeRow);
  if (!fanRowState.hasClass || fanRowState.stockVisible || !fanRowState.viewVisible) {
    fail(`M4-H: the OC-mode column must be hidden on the fan view (class ${fanRowState.hasClass}, Stock visible ${fanRowState.stockVisible}, view pill visible ${fanRowState.viewVisible})`);
  }
  // M4-H (B)/M4-I (E2): the Save-as-Profile action is OC-view only - never
  // on the fan view (the compact row button is HIDDEN like the OC column -
  // the pin targets the button's VISIBILITY, the element lives in the row).
  const fanSaveBtnHidden = await js(`(() => {
    const row = document.querySelector('.oc-mode-row');
    const btn = document.querySelector('.profile-save-btn');
    if (!row || !btn) return 'no-elements';
    return JSON.stringify({
      rowClass: row.classList.contains('fan-hides-save-btn'),
      visible: btn.offsetParent !== null,
    });
  })()`);
  const fanSaveState = JSON.parse(fanSaveBtnHidden);
  if (!fanSaveState.rowClass || fanSaveState.visible) {
    fail(`M4-I: the Save-as-Profile button must be HIDDEN on the fan view (class ${fanSaveState.rowClass}, visible ${fanSaveState.visible}): ${fanSaveBtnHidden}`);
  }
  step('fan-redirect', `#/fan -> Tuning page with the Fan Curve sub-view active; M4-H/M4-I: OC-mode column + Save-as-Profile button hidden on the fan view (View pill stays, no Save-as-Profile card)`);
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
  // .fan-stage overflow:hidden) - they hug the edge (translateY(0) /
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
  // M4-A (correction): the Fan page renders NO waiver status - the row
  // lives only in the dashboard GPU Status card (the waiver was accepted
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
    // M4-D2 (§1): the shared close-to-tray REAL close probe is the LAST step
    // of EVERY variant - incl. the fan-readonly early exit.
    await runCloseToTrayProbe(win);
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
  // writes are genuinely unsupported on this card) - the Fixed chip must
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
  step('fan-m4c-fixed', `M4-C: Fixed tab always renders - chip disabled (${toggleState}), note '${fixedNote.trim()}'`);

  // --- M4-C + M4-H: dot hover readout + live drag readout ------------------
  // Hover a dot: the popup shows the label ("85% @ 72 °C · #N"-style) and
  // the two editable inputs (Fan % + Temp) synced to the point (M4-H: the
  // label is a NODE - showReadout updates the label + the input values,
  // never textContent). M4N: under the FIXED Intel table the LAST dot is
  // (85, 50) - the readout must still be FULLY VISIBLE (inside the stage
  // bounds; the old 88C/100% top-edge flip check is DEAD under the new
  // table and dropped - no dot reaches 100 % anymore).
  const hoverOk = await js(`(() => {
    const dots = Array.from(document.querySelectorAll('.fan-dot'));
    const dot = dots[dots.length - 1];
    dot.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    const ro = document.querySelector('.fan-dot-readout');
    if (!ro || ro.hidden) return 'readout-hidden';
    const label = ro.querySelector('.fan-dot-readout-label');
    const want = dot.dataset.speed + '% @ ' + dot.dataset.t + ' °C · #' + dot.dataset.idx;
    if (label.textContent !== want) return 'mismatch:' + label.textContent + ' != ' + want;
    const tInp = ro.querySelector('input[data-readout-field="t"]');
    const sInp = ro.querySelector('input[data-readout-field="speed"]');
    if (!tInp || !sInp) return 'no-inputs';
    if (tInp.value !== dot.dataset.t || sInp.value !== dot.dataset.speed) {
      return 'input-mismatch:' + tInp.value + '/' + sInp.value + ' != ' + dot.dataset.t + '/' + dot.dataset.speed;
    }
    const stage = document.querySelector('.fan-stage');
    const sr = stage.getBoundingClientRect();
    const rr = ro.getBoundingClientRect();
    const inside = rr.top >= sr.top - 0.5 && rr.bottom <= sr.bottom + 0.5
      && rr.left >= sr.left - 0.5 && rr.right <= sr.right + 0.5;
    if (!inside) return 'clipped-outside-stage:' + JSON.stringify({ sr: [sr.top, sr.bottom, sr.left, sr.right], rr: [rr.top, rr.bottom, rr.left, rr.right] });
    return 'ok';
  })()`);
  if (hoverOk !== 'ok') fail(`M4-C/M4-H: hover readout: ${hoverOk}`);
  // M4-H (S2 - the vanish guard): a pointerout whose relatedTarget is
  // INSIDE the popup must NOT hide it (the popup is a sibling of the dots -
  // moving from a dot into the popup fires exactly this event; hiding there
  // would kill the popup before a click can land). The popup must also
  // STAY visible while the pointer is over it.
  const vanishGuard = await js(`(() => {
    const ro = document.querySelector('.fan-dot-readout');
    const dot = Array.from(document.querySelectorAll('.fan-dot')).at(-1);
    dot.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: ro }));
    const keptByRelatedTarget = ro.hidden === false;
    ro.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    dot.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null }));
    const keptByPointerInside = ro.hidden === false;
    ro.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    dot.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null }));
    const hiddenAfterLeave = ro.hidden === true;
    return keptByRelatedTarget && keptByPointerInside && hiddenAfterLeave
      ? 'ok'
      : JSON.stringify({ keptByRelatedTarget, keptByPointerInside, hiddenAfterLeave });
  })()`);
  if (vanishGuard !== 'ok') fail(`M4-H: the readout vanish guard failed: ${vanishGuard}`);
  // A plain pointerout (relatedTarget null) hides the readout.
  await js(`document.querySelector('.fan-dot')?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))`);
  if (!(await waitFor(win, `document.querySelector('.fan-dot-readout')?.hidden === true`, 5000))) {
    fail('M4-C: the hover readout did not hide on pointerout');
  }
  // Drag the same dot: the readout must appear and LIVE-UPDATE during the
  // move, then hide on release. M4N: the drag target is (25, 60) - under
  // the FIXED Intel table the t=30 column already holds a dot (the add
  // step above inserted at the widest gap 20-30), so the drag pins a spot
  // with room between the 20 C and 30 C neighbors.
  const dragOk = await js(`(() => {
    const stage = document.querySelector('.fan-stage');
    const rect = stage.getBoundingClientRect();
    const dot = Array.from(document.querySelectorAll('.fan-dot')).find((d) => Number(d.dataset.idx) === 1);
    dot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, clientX: rect.left + rect.width * 0.5, clientY: rect.top + rect.height * 0.5 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7, clientX: rect.left + rect.width * 0.25, clientY: rect.top + rect.height * 0.4 }));
    const ro = document.querySelector('.fan-dot-readout');
    const moved = document.querySelector('.fan-dot[data-idx="1"]');
    const movedOk = moved && Number(moved.dataset.t) === 25 && Number(moved.dataset.speed) === 60;
    const roOk = !!ro && !ro.hidden && ro.querySelector('.fan-dot-readout-label')?.textContent === '60% @ 25 °C · #1';
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }));
    const hiddenAfter = document.querySelector('.fan-dot-readout')?.hidden === true;
    return movedOk && roOk && hiddenAfter
      ? 'ok'
      : JSON.stringify({ moved: moved ? [moved.dataset.t, moved.dataset.speed] : null, ro: ro?.querySelector('.fan-dot-readout-label')?.textContent, roHidden: ro?.hidden, hiddenAfter });
  })()`);
  if (dragOk !== 'ok') fail(`M4-C: drag readout: ${dragOk}`);
  step('fan-m4c-hover', 'M4-C/M4-H: dot hover popup (label + editable inputs synced), vanish guard (pointerout with relatedTarget inside the popup / pointer over the popup keeps it; leaving hides), live during drag, hidden on pointerout/up');

  // M4-C round-1 fix: a stale hover readout must NOT survive a mode switch -
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

  // --- M4-H (A2): the POPUP EDIT path (the per-point boxes are DELETED) --
  // The popup's two inputs replace the old .fan-points-editor row - the
  // row must be GONE everywhere. The edit clamps: a typed temp clamps
  // strictly between the neighbors (dot dataset.t + the input value must
  // show the clamped temp), a typed speed clamps 0..100, the clamped value
  // reflects back into the input, an EMPTIED input keeps the previous
  // value.
  if (await js(`!!document.querySelector('.fan-points-editor')`)) {
    fail('M4-H: the per-point boxes row (.fan-points-editor) is still rendered (deleted - the popup inputs replace it)');
  }
  // M4-I (F1): HOVER shows the PLAIN label readout (pre-M4H behavior) -
  // pointer-events: none with the editable FIELDS hidden; hovering never
  // edits.
  const hoverIsPlain = await js(`(() => {
    const dots = Array.from(document.querySelectorAll('.fan-dot'));
    const dot = dots.find((d) => Number(d.dataset.idx) === 3);
    dot.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    const ro = document.querySelector('.fan-dot-readout');
    if (!ro || ro.hidden) return 'readout-hidden';
    const editing = ro.classList.contains('fan-dot-readout-editing');
    const fieldsDisplay = getComputedStyle(ro.querySelector('.fan-dot-readout-fields')).display;
    const pe = getComputedStyle(ro).pointerEvents;
    dot.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null }));
    const hiddenAfter = ro.hidden === true;
    return !editing && fieldsDisplay === 'none' && pe === 'none' && hiddenAfter
      ? 'ok'
      : JSON.stringify({ editing, fieldsDisplay, pe, hiddenAfter });
  })()`);
  if (hoverIsPlain !== 'ok') fail(`M4-I (F1): hover must show the PLAIN label readout (pointer-events none, fields hidden, hides on pointerout): ${hoverIsPlain}`);
  step('fan-m4i-hover-plain', 'M4-I (F1): hover = the plain label readout (pointer-events none, fields hidden, hides on pointerout) - hovering never edits');

  // M4-I (F1): CLICK (pointerdown+up with NO movement) elevates the dot to
  // the EDITABLE popup - the fields become visible and the popup STAYS.
  // The click sequence is embedded (page-side) - the helper is a source
  // string so it can ride INSIDE larger executeJavaScript expressions.
  const EDIT_DOT_SRC = (idx) => `(() => {
    const dot = Array.from(document.querySelectorAll('.fan-dot')).find((d) => Number(d.dataset.idx) === ${idx});
    if (!dot) return false;
    const r = dot.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    dot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, clientX: x, clientY: y }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, clientX: x, clientY: y }));
    return true;
  })()`;
  const editDotFor = (idx) => js(EDIT_DOT_SRC(idx));
  const clickEditOk = await js(`(() => {
    ${EDIT_DOT_SRC(3)}
    const ro = document.querySelector('.fan-dot-readout');
    if (!ro || ro.hidden) return 'readout-hidden';
    const editing = ro.classList.contains('fan-dot-readout-editing');
    const fieldsDisplay = getComputedStyle(ro.querySelector('.fan-dot-readout-fields')).display;
    const pe = getComputedStyle(ro).pointerEvents;
    return editing && fieldsDisplay === 'flex' && pe === 'auto' ? 'ok' : JSON.stringify({ editing, fieldsDisplay, pe });
  })()`);
  if (clickEditOk !== 'ok') fail(`M4-I (F1): clicking a dot must elevate it to the EDITABLE popup (fields visible, pointer-events auto): ${clickEditOk}`);
  step('fan-m4i-click-edit', 'M4-I (F1): clicking a dot (pointerdown+up, no movement) elevates it to the EDITABLE popup (fields visible, pointer-events auto)');

  // M4-I (F1): while EDITING the hover-dismiss is DISABLED - a pointerout
  // (or a focus-out) never closes the editable popup; it only closes via
  // another dot's click (the popup moves) or an outside click.
  const editingKeeps = await js(`(() => {
    const ro = document.querySelector('.fan-dot-readout');
    const tInp = ro.querySelector('input[data-readout-field="t"]');
    const dot = Array.from(document.querySelectorAll('.fan-dot')).find((d) => Number(d.dataset.idx) === 3);
    dot.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null }));
    const keptAfterPointerout = ro.hidden === false;
    ro.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    const keptAfterPointerleave = ro.hidden === false;
    tInp.focus();
    tInp.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
    const keptAfterFocusout = ro.hidden === false;
    return keptAfterPointerout && keptAfterPointerleave && keptAfterFocusout ? 'ok' : JSON.stringify({ keptAfterPointerout, keptAfterPointerleave, keptAfterFocusout });
  })()`);
  if (editingKeeps !== 'ok') fail(`M4-I (F1): while editing the popup must survive pointerout/pointerleave/focusout: ${editingKeeps}`);
  // Clicking ANOTHER dot moves the editable popup to it (the editing
  // switches; the popup stays open).
  const clickMoves = await js(`(() => {
    ${EDIT_DOT_SRC(1)}
    const ro = document.querySelector('.fan-dot-readout');
    const stillOpen = !!ro && !ro.hidden && ro.classList.contains('fan-dot-readout-editing');
    const idx = ro?.dataset['idx'] ?? '';
    return stillOpen && idx === '1' ? 'ok' : JSON.stringify({ stillOpen, idx });
  })()`);
  if (clickMoves !== 'ok') fail(`M4-I (F1): clicking another dot must MOVE the editable popup to it: ${clickMoves}`);
  // A click OUTSIDE (a document-level pointerdown while editing) closes the
  // editable popup and ends the editing.
  const clickOutside = await js(`(() => {
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }));
    const ro = document.querySelector('.fan-dot-readout');
    return !ro || ro.hidden === true ? 'ok' : 'popup-still-open';
  })()`);
  if (clickOutside !== 'ok') fail(`M4-I (F1): a click outside must close the editable popup: ${clickOutside}`);
  step('fan-m4i-edit-lifecycle', 'M4-I (F1): while editing, pointerout/pointerleave/focusout keep the popup; clicking another dot moves it; a click outside closes it');

  // Typing a colliding temp clamps between the neighbors. M4N: with the
  // FIXED Intel table + the drag above (dot 1 at 25 C) the neighbors of
  // dot 2 are 25 C and 40 C - typing 80 clamps to 39 (next.t - 1).
  await editDotFor(2);
  const popupTemp = await js(`(() => {
    const inp = document.querySelector('.fan-dot-readout input[data-readout-field="t"]');
    inp.value = '80';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const dot = document.querySelector('.fan-dot[data-idx="2"]');
    return dot.dataset.t + '/' + inp.value;
  })()`);
  if (popupTemp !== '39/39') fail(`M4-H: popup temp edit: got '${popupTemp}' (expected 39/39 - clamped strictly below the 40 C neighbor)`);
  // Typing an over-range speed clamps to 100.
  const popupSpeed = await js(`(() => {
    const inp = document.querySelector('.fan-dot-readout input[data-readout-field="speed"]');
    inp.value = '150';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const dot = document.querySelector('.fan-dot[data-idx="2"]');
    return dot.dataset.speed + '/' + inp.value;
  })()`);
  if (popupSpeed !== '100/100') fail(`M4-H: popup speed edit: got '${popupSpeed}' (expected 100/100 - clamped to 0..100)`);
  // TYPED temps are clamped to the static 0..100 domain like the drag path
  // (typing 150 / -5 into the OUTER points must clamp to 100 / 0). The
  // popup holds ONE input pair - the last-dot values are captured BEFORE
  // switching the popup to the first dot (a click MOVES the editing).
  const popupOuter = await js(`(() => {
    const dots = Array.from(document.querySelectorAll('.fan-dot'));
    ${EDIT_DOT_SRC('(dots.length - 1)')}
    const lastInp = document.querySelector('.fan-dot-readout input[data-readout-field="t"]');
    lastInp.value = '150';
    lastInp.dispatchEvent(new Event('input', { bubbles: true }));
    const lastT = document.querySelector('.fan-dot[data-idx="' + (dots.length - 1) + '"]').dataset.t;
    const lastVal = lastInp.value;
    ${EDIT_DOT_SRC(0)}
    const firstInp = document.querySelector('.fan-dot-readout input[data-readout-field="t"]');
    firstInp.value = '-5';
    firstInp.dispatchEvent(new Event('input', { bubbles: true }));
    const firstT = document.querySelector('.fan-dot[data-idx="0"]').dataset.t;
    return lastT + '/' + lastVal + '/' + firstT + '/' + firstInp.value;
  })()`);
  if (popupOuter !== '100/100/0/0') fail(`M4-H: popup temp domain clamp: got '${popupOuter}' (expected 100/100/0/0 - typing 150 / -5 clamps to the static 0..100 domain)`);
  // An EMPTIED input must NOT be treated as 0 - clearing the temp AND
  // speed inputs of point 1 must leave the dot dataset unchanged and both
  // inputs as the user left them ('').
  await editDotFor(1);
  const popupEmpty = await js(`(() => {
    const dot = document.querySelector('.fan-dot[data-idx="1"]');
    const before = dot.dataset.t + '/' + dot.dataset.speed;
    for (const field of ['t', 'speed']) {
      const inp = document.querySelector('.fan-dot-readout input[data-readout-field="' + field + '"]');
      inp.value = '';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const after = dot.dataset.t + '/' + dot.dataset.speed;
    const tVal = document.querySelector('.fan-dot-readout input[data-readout-field="t"]').value;
    const sVal = document.querySelector('.fan-dot-readout input[data-readout-field="speed"]').value;
    return before + '|' + after + '|' + tVal + '|' + sVal;
  })()`);
  const [peBefore, peAfter, peT, peS] = popupEmpty.split('|');
  if (peBefore !== peAfter) fail(`M4-H: clearing a popup input moved the point (${peBefore} -> ${peAfter}) - an empty input must keep the previous value (Number('') is 0)`);
  if (peT !== '' || peS !== '') fail(`M4-H: cleared popup inputs were rewritten to '${peT}'/'${peS}' (expected both to stay '' - no point mutation on empty input)`);
  // The 'Remove point' ACTION-ROW button: one click removes the selected
  // point; at the 2-point floor the button is disabled and clicking is a
  // no-op (the per-point row remove is gone with the boxes).
  await js(`Array.from(document.querySelectorAll('#page button')).find((b) => b.textContent.includes('Remove point'))?.click()`);
  if (!(await waitFor(win, `document.querySelectorAll('.fan-dot').length === ${pointsAfter - 1}`, 5000))) {
    fail(`M4-H: the action-row remove did not remove one dot (expected ${pointsAfter - 1})`);
  }
  const floorOk = await js(`(() => {
    let guard = 0;
    while (document.querySelectorAll('.fan-dot').length > 2 && guard++ < 20) {
      Array.from(document.querySelectorAll('#page button')).find((b) => b.textContent.includes('Remove point'))?.click();
    }
    const count = document.querySelectorAll('.fan-dot').length;
    const removeBtn = Array.from(document.querySelectorAll('#page button')).find((b) => b.textContent.includes('Remove point'));
    const disabled = !!removeBtn && removeBtn.disabled;
    const before = count;
    removeBtn?.click();
    return count === 2 && disabled && document.querySelectorAll('.fan-dot').length === before;
  })()`);
  if (!floorOk) fail('M4-H: the action-row remove did not floor at MIN_CURVE_POINTS (2) with the button disabled');
  // Re-seed a couple of points so the preset step below has a sane curve.
  await js(`Array.from(document.querySelectorAll('#page button')).find((b) => b.textContent.includes('Add point'))?.click()`);
  await js(`Array.from(document.querySelectorAll('#page button')).find((b) => b.textContent.includes('Add point'))?.click()`);
  step('fan-m4h-popup-edit', 'M4-H: popup edit path - colliding temp clamped between (69), speed clamped to 100, outer domain clamp (150/-5 -> 100/0), empty input keeps the value, focus keeps the popup, action-row remove floors at 2 (disabled); no .fan-points-editor anywhere');

  // --- M4N (D): the FIXED-table preset chips --------------------------------
  // Exactly THREE chips: 'Intel Curve' (the FIXED 10-point STOCK_FAN_CURVE
  // constant - the chip restores the stock curve, never a live store read;
  // the mock fixture is pinned equal to the constant so this block also
  // validates that equality), 'Quiet' (the FIXED gentler table, capped at
  // 40 %), 'Max' (the FIXED steeper table, capped at 70 % - renamed from
  // 'Max cooling'). The M4M scaled derivation (x0.5/x1.35) is GONE - the
  // tables below are the exact literals (the main bundle cannot import
  // renderer TS; pure/curve.ts + test/pure-curve.test.ts pin them).
  if (await js(`document.body.textContent.includes('Max cooling')`)) {
    fail('M4-H: "Max cooling" is still rendered somewhere (renamed to "Max")');
  }
  if (await js(`document.body.textContent.includes('Reset to driver curve')`)) {
    fail('M4-H: the "Reset to driver curve" button is still rendered (the chip replaces it)');
  }
  const presetChips = await js(`JSON.stringify(Array.from(document.querySelectorAll('.fan-presets .chip')).map((c) => c.textContent.trim()))`);
  if (JSON.parse(presetChips).join(',') !== 'Intel Curve,Quiet,Max') {
    fail(`M4-I: the preset chips are '${presetChips}' (expected 'Intel Curve,Quiet,Max' - the M4-I rename)`);
  }
  const presetDots = () => js(`JSON.stringify(Array.from(document.querySelectorAll('.fan-dot')).map((d) => ({ t: Number(d.dataset.t), s: Number(d.dataset.speed) })))`);
  const clickPreset = (name) => js(`Array.from(document.querySelectorAll('.fan-presets .chip')).find((c) => c.textContent.trim() === '${name}')?.click()`);
  // The exact M4N tables (pure/curve.ts STOCK/QUIET/MAX_FAN_CURVE).
  const INTEL_TABLE = [
    { t: 20, s: 20 }, { t: 30, s: 22 }, { t: 40, s: 25 }, { t: 50, s: 28 },
    { t: 60, s: 32 }, { t: 65, s: 35 }, { t: 70, s: 40 }, { t: 75, s: 44 },
    { t: 80, s: 47 }, { t: 85, s: 50 },
  ];
  const QUIET_TABLE = [
    { t: 20, s: 20 }, { t: 30, s: 21 }, { t: 40, s: 22 }, { t: 50, s: 24 },
    { t: 60, s: 26 }, { t: 65, s: 28 }, { t: 70, s: 30 }, { t: 75, s: 33 },
    { t: 80, s: 36 }, { t: 85, s: 40 },
  ];
  const MAX_TABLE = [
    { t: 20, s: 20 }, { t: 30, s: 26 }, { t: 40, s: 32 }, { t: 50, s: 38 },
    { t: 60, s: 45 }, { t: 65, s: 50 }, { t: 70, s: 56 }, { t: 75, s: 62 },
    { t: 80, s: 66 }, { t: 85, s: 70 },
  ];
  // 'Intel Curve' restores the STOCK curve (the constant, clamped to the
  // device max - the mock fixture equals the constant, so the compare below
  // passes on both).
  await clickPreset('Intel Curve');
  await sleep(250);
  const driverDots = JSON.parse(await presetDots());
  const fixtureCurve = (await js(`window.arcPower.getCurrentSettings(0)`).then((s) => s.fanCurve))
    .map((p) => ({ t: p.t, s: p.speedPct }));
  if (JSON.stringify(driverDots) !== JSON.stringify(fixtureCurve)) {
    fail(`M4-I/M4N: 'Intel Curve' did not restore the stock curve: ${JSON.stringify(driverDots)} != ${JSON.stringify(fixtureCurve)}`);
  }
  if (JSON.stringify(driverDots) !== JSON.stringify(INTEL_TABLE)) {
    fail(`M4N: 'Intel Curve' is not the fixed Intel table (never exceeds 50 %, exactly 50 % at 85 C): ${JSON.stringify(driverDots)}`);
  }
  // 'Quiet' = the FIXED gentler table (never exceeds 40 %).
  await clickPreset('Quiet');
  await sleep(250);
  const quietDots = JSON.parse(await presetDots());
  if (quietDots.length !== fixtureCurve.length) fail(`M4N: 'Quiet' point count is ${quietDots.length} (expected ${fixtureCurve.length})`);
  if (JSON.stringify(quietDots) !== JSON.stringify(QUIET_TABLE)) {
    fail(`M4N: 'Quiet' is not the fixed Quiet table (never exceeds 40 %): ${JSON.stringify(quietDots)} vs ${JSON.stringify(QUIET_TABLE)}`);
  }
  // 'Max' = the FIXED steeper table (never exceeds 70 %).
  await clickPreset('Max');
  await sleep(250);
  const maxDots = JSON.parse(await presetDots());
  if (maxDots.length !== fixtureCurve.length) fail(`M4N: 'Max' point count is ${maxDots.length} (expected ${fixtureCurve.length})`);
  if (JSON.stringify(maxDots) !== JSON.stringify(MAX_TABLE)) {
    fail(`M4N: 'Max' is not the fixed Max table (never exceeds 70 %): ${JSON.stringify(maxDots)} vs ${JSON.stringify(MAX_TABLE)}`);
  }
  step('fan-presets', `M4N: preset chips '${presetChips}'; Intel Curve restores the fixed 10-point stock curve (50 % cap at 85 C); Quiet/Max are the fixed tables -> ${JSON.stringify(quietDots)} / ${JSON.stringify(maxDots)}; no 'Max cooling' text`);

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
  // message (per.message wins over the errorCode mapping - review MINOR 1).
  backend.injectFail('fanCurve', 'io-failed');
  await clearToasts();
  await js(`Array.from(document.querySelectorAll('#page button')).find((b) => b.textContent.includes('Apply fan settings'))?.click()`);
  if (!(await waitFor(win, `!!document.querySelector('.toast-error')`, 5000))) fail('fan apply refusal toast missing');
  const refuseMsg = await js(`document.querySelector('.toast-error .toast-message')?.textContent ?? ''`);
  if (!/refused the change/.test(refuseMsg)) fail(`fan refusal toast did not use the composed message: '${refuseMsg}'`);
  if (/read-back mismatch/.test(refuseMsg)) fail(`fan refusal toast fell back to the errorCode mapping: '${refuseMsg}'`);
  backend.injectFail('fanCurve', null);
  step('fan-fail-toast', `fan apply failure mapped: '${errMsg}' (hard) + refusal composed: '${refuseMsg}'`);

  // --- 8. startup channels (M4-D2): the ONE Run value + the derivation ----
  // startup-get composes { startWithWindows, applyOnBoot } from the raw
  // value + the persisted settings; startup-set(enabled) writes the shared
  // value (the bare "<exe>"). The booleans follow the SETTINGS, so the pins
  // persist each toggle's intent first.
  const startState = await js(`window.arcPower.startupGet()`);
  if (startState.startWithWindows !== false || startState.applyOnBoot !== false) {
    fail(`startupGet initial state: ${JSON.stringify(startState)}`);
  }
  // Derivation A: startWithWindows owns the value.
  await js(`window.arcPower.profilesSettingsSave({ startWithWindows: true })`);
  const setOn = await js(`window.arcPower.startupSet(true)`);
  if (setOn.startWithWindows !== true || setOn.applyOnBoot !== false) fail(`startupSet(true) with startWithWindows: ${JSON.stringify(setOn)}`);
  const setOff = await js(`window.arcPower.startupSet(false)`);
  if (setOff.startWithWindows !== false || setOff.applyOnBoot !== false) fail(`startupSet(false): ${JSON.stringify(setOff)}`);
  await js(`window.arcPower.profilesSettingsSave({ startWithWindows: false })`);
  // Derivation B: the profile's start-at-boot (ocOnBoot + active profile)
  // owns the SAME value - applyOnBoot composes true, startWithWindows false.
  await js(`window.arcPower.profilesSettingsSave({ ocOnBoot: true, activeProfileId: 'profile-1' })`);
  const bootOn = await js(`window.arcPower.startupSet(true)`);
  if (bootOn.startWithWindows !== false || bootOn.applyOnBoot !== true) fail(`startupSet(true) with ocOnBoot: ${JSON.stringify(bootOn)}`);
  const bootOff = await js(`window.arcPower.startupSet(false)`);
  if (bootOff.startWithWindows !== false || bootOff.applyOnBoot !== false) fail(`startupSet(false) with ocOnBoot: ${JSON.stringify(bootOff)}`);
  // Validation: enabled must be a boolean (the old two-arg call shape is
  // gone - a second arg is ignored, never required).
  const badRejected = await js(`(async () => { try { await window.arcPower.startupSet('yes'); return 'accepted'; } catch (e) { return 'rejected'; } })()`);
  if (badRejected !== 'rejected') fail(`startupSet('yes') was not rejected (${badRejected})`);
  const twoArgIgnored = await js(`window.arcPower.startupSet(true, 'profile-1')`);
  if (twoArgIgnored.startWithWindows !== false) fail(`startupSet(true, id) - the second arg must be ignored: ${JSON.stringify(twoArgIgnored)}`);
  // Restore the baseline (value off, ocOnBoot off).
  await js(`window.arcPower.startupSet(false)`);
  await js(`window.arcPower.profilesSettingsSave({ ocOnBoot: false, activeProfileId: null })`);
  step('startup-ipc', `startup channels: derivation A (startWithWindows true/false via startupSet), derivation B (applyOnBoot via ocOnBoot), validation ('yes' rejected, 2nd arg ignored), baseline restored`);

  // --- 8b. M4-D: sysinfo + window-op channels through the REAL preload ------
  // The mock adapter serves the fixed fixture (never PowerShell); the
  // injected window ops COUNT in ui-verify mode (performing minimize/close
  // mid-verify would disrupt the flow) - run 2 pins the title-bar buttons
  // via getWindowOpCounts.
  const sysinfo = await js(`window.arcPower.sysinfo()`);
  if (sysinfo?.cpu?.name !== 'Intel(R) Core(TM) i7-14700K' || sysinfo?.cpu?.cores !== 20) {
    fail(`sysinfo IPC payload wrong: ${JSON.stringify(sysinfo)}`);
  }
  if (sysinfo?.videoControllers?.[0]?.name !== 'Intel(R) Arc(TM) A770 Graphics') {
    fail(`sysinfo videoControllers wrong: ${JSON.stringify(sysinfo?.videoControllers)}`);
  }
  // Snapshot BEFORE the calls (a live reference would read the post-call
  // values for both sides - the counters are a single mutable object).
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

  // M4M (B)/M4N (B): the readout is TWO groups - CPU (the dashboard tiles
  // verbatim, M4N order: Util / Core Frequency (GHz) / Temperature / Power)
  // ABOVE GPU (the dashboard GPU order, M4N: Util / Core clock / Memory
  // clock / VRAM (GB) / Temperature / Power / Fan + the FPS tile - the
  // M4M 'Utilization' tile is renamed 'Util', the MiB tile becomes 'VRAM').
  // The tile lookups are GROUP-SCOPED (both groups carry Temperature-like
  // labels).
  const cpuLabels = await js(`Array.from(document.querySelectorAll('#mon-readout-cpu .stat-label')).map((l) => l.textContent).join(',')`);
  const gpuLabels = await js(`Array.from(document.querySelectorAll('#mon-readout-gpu .stat-label')).map((l) => l.textContent).join(',')`);
  if (cpuLabels.split(',').join(',') !== 'Util,Core Frequency,Temperature,Power') {
    fail(`M4N: the monitoring CPU group order is '${cpuLabels}' (expected Util, Core Frequency, Temperature, Power - the dashboard order)`);
  }
  if (gpuLabels.split(',').join(',') !== 'Util,Core clock,Memory clock,VRAM,Voltage,VramTemp,Temperature,Power,Fan,FPS') {
    fail(`M16: the monitoring GPU group order is '${gpuLabels}' (expected Util, Core clock, Memory clock, VRAM, Voltage, VramTemp, Temperature, Power, Fan, FPS - the M16 Voltage + VramTemp tiles)`);
  }
  for (const want of ['Core Frequency', 'Util', 'Temperature', 'Power']) {
    if (!cpuLabels.includes(want)) fail(`monitoring CPU group missing '${want}' (got '${cpuLabels}')`);
  }
  for (const want of ['Core clock', 'Memory clock', 'Temperature', 'Power', 'Util', 'Fan', 'FPS', 'VRAM', 'Voltage', 'VramTemp']) {
    if (!gpuLabels.includes(want)) fail(`monitoring GPU group missing '${want}' (got '${gpuLabels}')`);
  }
  if (await js(`Array.from(document.querySelectorAll('#mon-readout-gpu .stat-label')).some((l) => l.textContent === 'Utilization' || l.textContent === 'GPU memory')`)) {
    fail(`M4N: the old monitoring labels 'Utilization'/'GPU memory' are still rendered (got '${gpuLabels}')`);
  }
  // M4-D2 (§11)/M4N: the tiles read the mock system-stats (42 % util,
  // 61 °C, 2971324416 bytes -> '3.0' GB VRAM, 4300 MHz -> '4.3' GHz).
  const tileOf = (group, label) => `Array.from(document.querySelectorAll('#mon-readout-${group} .stat-tile')).find((t) => (t.querySelector('.stat-label')?.textContent ?? '') === '${label}')?.querySelector('.stat-value')?.textContent ?? ''`;
  if (!(await waitFor(win, `(${tileOf('cpu', 'Util')}) === '42'`, 8000))) {
    fail(`CPU Util tile is '${await js(tileOf('cpu', 'Util'))}' (expected '42' - the mock cpuUtilPct)`);
  }
  // M4N (B.2): the CPU Core Frequency tile reads the mock cpuFreqMhz 4300
  // as '4.3' GHz (the shared ghzFreq helper) - the value + the unit.
  if (!(await waitFor(win, `(() => {
    const tile = Array.from(document.querySelectorAll('#mon-readout-cpu .stat-tile')).find((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'Core Frequency');
    return !!tile && (tile.querySelector('.stat-value')?.textContent ?? '') === '4.3' && (tile.querySelector('.stat-unit')?.textContent ?? '') === 'GHz';
  })()`, 8000))) {
    fail(`CPU Core Frequency tile is not '4.3' GHz: '${await js(tileOf('cpu', 'Core Frequency'))}'`);
  }
  // M4-I (C1): the mock temp VARIES 61/62 - the exact-value pin accepts both
  // (under RID_MOCK_FROZEN_TEMP=1 the shared frozenDrop already reports '-'
  // by the time the verify reaches monitoring - the gated pin below asserts
  // that state explicitly).
  const cpuTemp = await js(tileOf('cpu', 'Temperature'));
  const frozenActive = process.env.RID_MOCK_FROZEN_TEMP === '1';
  if (!(cpuTemp === '61' || cpuTemp === '62' || (frozenActive && cpuTemp === '-'))) {
    fail(`CPU Temperature tile is '${cpuTemp}' (expected '61'|'62' - the varying mock${frozenActive ? ', or the frozen "-"' : ''})`);
  }
  if ((await js(tileOf('gpu', 'VRAM'))) !== '3.0') fail(`VRAM tile is '${await js(tileOf('gpu', 'VRAM'))}' (expected '3.0' GB - 2971324416 / 1e9, one decimal)`);
  // M16: the Voltage + VramTemp tiles read the mock telemetry (0.652 V /
  // tempCBase + 8 + tick%10 -> 44..53 °C - the temp is pattern-matched).
  if ((await js(tileOf('gpu', 'Voltage'))) !== '0.652') fail(`Voltage tile is '${await js(tileOf('gpu', 'Voltage'))}' (expected '0.652' V - the mock gpuVoltageV)`);
  if (!/^\d+$/.test(await js(tileOf('gpu', 'VramTemp')))) fail(`VramTemp tile is '${await js(tileOf('gpu', 'VramTemp'))}' (expected the 44..53 °C ramp)`);
  step('mon-readout', `monitoring readout groups: CPU '${cpuLabels}', GPU '${gpuLabels}'; CPU Util 42 % / Core Frequency 4.3 GHz / CPU temp ${cpuTemp} °C / VRAM 3.0 GB / Voltage 0.652 V / VramTemp ${await js(tileOf('gpu', 'VramTemp'))} °C (compact)`);

  // M4-I (C1): RID_MOCK_FROZEN_TEMP=1 -> the mock temp is CONSTANT, so the
  // shared frozenDrop reports null after 5 identical samples - the CPU
  // group's Temperature tile reads the honest '-' (the verifiable
  // Z97-static-zone shape). Gated: the knob is NOT part of the default
  // matrix.
  if (process.env.RID_MOCK_FROZEN_TEMP === '1') {
    if (!(await waitFor(win, `(${tileOf('cpu', 'Temperature')}) === '-'`, 12000))) {
      fail(`M4-I (C1): RID_MOCK_FROZEN_TEMP=1 - the CPU Temperature tile is '${await js(tileOf('cpu', 'Temperature'))}' (expected '-' - 5 identical samples trip the shared frozenDrop)`);
    }
    step('mon-frozen', 'M4-I (C1): RID_MOCK_FROZEN_TEMP=1 - the frozen mock temp drops to the honest "-" (the Z97 static-zone shape)');
  }
  // M4-I (C2): RID_MOCK_NO_POWER_METER=1 -> the mock's cpuPowerW stays null
  // (the honest no-metering shape) - the dashboard Power tile reads '-'
  // (M4N: renamed from Wattage).
  if (process.env.RID_MOCK_NO_POWER_METER === '1') {
    await js(`location.hash = '#/dashboard'`);
    if (!(await waitFor(win, `Array.from(document.querySelectorAll('#dash-readout-cpu .stat-tile')).find((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'Power')?.querySelector('.stat-value')?.textContent === '-'`, 8000))) {
      fail('M4-I (C2): RID_MOCK_NO_POWER_METER=1 - the Power tile does not read "-" (the mock cpuPowerW must stay null-honest)');
    }
    await js(`location.hash = '#/monitoring'`);
    await sleep(250);
    step('mon-no-power', 'M4-I (C2): RID_MOCK_NO_POWER_METER=1 - the Power tile reads "-" (no PowerMeter -> honest)');
  }

  if (process.env.RID_MOCK_FPS === '1') {
    // M4-D2: RID_MOCK_FPS=1 -> the FPS tile shows the FIXED mock value.
    if (!(await waitFor(win, `(${tileOf('gpu', 'FPS')}) === '60'`, 8000))) {
      fail(`FPS tile is '${await js(tileOf('gpu', 'FPS'))}' (expected '60' - the RID_MOCK_FPS fixed sample)`);
    }
    step('mon-fps-mock', `RID_MOCK_FPS=1: FPS tile reads the fixed mock value (60)`);
  } else {
    if (!(await waitFor(win, `(document.querySelector('.mon-fps-note')?.textContent ?? '').includes('FPS unavailable')`, 5000))) {
      fail('FPS did not degrade to "FPS unavailable" (mock fps-poll -> null)');
    }
    step('mon-fps', `FPS unavailable shown gracefully: '${await js(`document.querySelector('.mon-fps-note')?.textContent ?? ''`)}'`);
  }
  // M4M (G): the "Log to file" card is REMOVED from the Monitoring page -
  // the Settings page is its single home. The Monitoring page must render
  // NO .mon-log-card / .mon-log-checkbox.
  if (await js(`!!document.querySelector('.mon-log-card') || !!document.querySelector('.mon-log-checkbox')`)) {
    fail('M4M: the Monitoring page still renders the Log to file card (removed - the Settings page owns the toggle)');
  }
  await js(`location.hash = '#/settings'`);
  if (!(await waitFor(win, `!!document.querySelector('.settings-checkbox[data-setting="monitorLogToFile"]')`, 5000))) {
    fail('M4M: the Settings page does not render the monitorLogToFile toggle (its single home)');
  }
  await js(`location.hash = '#/monitoring'`);
  await sleep(250);
  step('mon-log-toggle', 'M4M (G): Monitoring has NO Log to file card; the Settings page HAS the .settings-checkbox[data-setting="monitorLogToFile"] toggle');

  const canvases = await js(`document.querySelectorAll('.seg-canvas').length`);
  if (canvases !== 5) fail(`expected 5 canvases, got ${canvases}`);
  step('mon-canvas', `${canvases} canvas graphs rendered from telemetry pushes`);

  // --- M9: the Monitoring | Overlay view switch (the S2 re-registration) ----
  // The view pill renders 'Monitoring | Overlay' at the page top; the
  // round trip (monitoring -> overlay -> monitoring) must return the
  // readout grid AND keep the FPS tile LIVE - every monitoring-view
  // rebuild re-registers the canvases + the FPS tile + the note (the S2
  // contract), so the poll writes into the live view, never into the
  // detached nodes a clear() orphaned.
  const viewLabels = await js(`Array.from(document.querySelectorAll('.mon-view-btn')).map((b) => (b.textContent ?? '').trim()).join('|')`);
  if (viewLabels !== 'Monitoring|Overlay') fail(`M9: the Monitoring view pill must read 'Monitoring|Overlay' (got '${viewLabels}')`);
  // overlay -> the Overlay Settings content renders (its own heading).
  await js(`(() => { const b = Array.from(document.querySelectorAll('.mon-view-btn')).find((x) => (x.textContent ?? '').trim() === 'Overlay'); b.click(); })()`);
  if (!(await waitFor(win, `(document.getElementById('page')?.textContent ?? '').includes('Overlay Settings')`, 8000))) {
    fail('M9: the Overlay view did not render the Overlay Settings content');
  }
  // monitoring -> the readout grid returns.
  await js(`(() => { const b = Array.from(document.querySelectorAll('.mon-view-btn')).find((x) => (x.textContent ?? '').trim() === 'Monitoring'); b.click(); })()`);
  if (!(await waitFor(win, `document.querySelectorAll('#mon-readout-gpu .stat-tile').length >= 10`, 8000))) {
    fail('M16: switching back to the Monitoring view did not return the readout grid (10 GPU tiles - the M16 Voltage + VramTemp added)');
  }
  // The FPS tile is LIVE after the round trip (the S2 re-registration - the
  // poll writes into the re-registered tile, never the detached one).
  if (process.env.RID_MOCK_FPS === '1') {
    if (!(await waitFor(win, `(${tileOf('gpu', 'FPS')}) === '60'`, 8000))) {
      fail(`M9 (S2): the FPS tile is '${await js(tileOf('gpu', 'FPS'))}' after the view round trip (expected '60' - the poll must write into the re-registered tile)`);
    }
    step('m9-mon-view-switch', `M9: the Monitoring|Overlay pill round-tripped; the readout grid returned + the FPS tile stays live (S2 re-registration, ${await js(tileOf('gpu', 'FPS'))} FPS)`);
  } else {
    if (!(await waitFor(win, `(document.querySelector('.mon-fps-note')?.textContent ?? '').includes('FPS unavailable')`, 5000))) {
      fail('M9 (S2): the FPS note did not re-render after the view round trip');
    }
    step('m9-mon-view-switch', 'M9: the Monitoring|Overlay pill round-tripped; the readout grid returned + the FPS note stays live (S2 re-registration)');
  }

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
  // M4-C round-2 fix: RIGHT-EDGE hovers - the NEWEST sample, the common
  // case - must keep the popup inside the card. The old unclamped
  // centering (left = 10 + x with x up to w - 8) pushed the ~120px box up
  // to ~60px past the card's right edge and .seg-card{overflow:hidden}
  // clipped the "· N s ago" tail. Hover exactly at the canvas's right edge
  // (xNorm = 1 -> the newest sample) and assert the popup's
  // getBoundingClientRect() is inside the seg-card's. The flip-below is
  // asserted whenever the hovered sample sits in the no-room-above zone
  // (top-edge samples - the box used to park over the segment header):
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
  step('mon-m4c-popup-edge', 'M4-C: right-edge hover (newest sample) keeps the popup inside the card - horizontal clamp + top-edge flip-below');
  // M4-C round-1 fix: a STATIONARY hover must survive telemetry ticks -
  // redrawAll passes the persisted hover crosshair back into drawSeries
  // (before the fix the crosshair vanished on every tick while the popup
  // stayed). Probe canvas pixels in the crosshair's column away from the
  // sample: the dashed vertical line lights roughly half of them; without
  // persistence the column is bare (the polyline crosses it at ONE point
  // only - excluded by the band around y; the horizontal grid lines add a
  // handful at most).
  // M4-F (run 2): the wait is now a POLL instead of one fixed 2.6 s sleep -
  // the fixed sleep flaked under machine load (the pin then raced the
  // redraw timing). The poll waits for the FIRST tick to have landed (a
  // pre-tick pass would prove nothing), then retries up to 8 s: the
  // crosshair persists across ticks, so any post-tick check catches it -
  // while a lost crosshair (the bug) stays gone after the first tick and
  // the poll times out honestly.
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
    // Let at least one telemetry tick land (0.5 s cadence) BEFORE the
    // first post-tick check - a pre-tick pass would prove nothing.
    await new Promise((r) => setTimeout(r, 750));
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const now = columnLits();
      if (now >= 10) return 'ok';
      await new Promise((r) => setTimeout(r, 250));
    }
    return 'crosshair-lost-after-tick:' + columnLits() + ' (before ' + before + ')';
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
    for (const p of env.profiles.filter((x) => (x.name ?? '').startsWith('ui-verify') || (x.id ?? '').startsWith('boot-probe'))) {
      await js(`window.arcPower.profilesDelete('${p.id}')`).catch(() => {});
    }
    const st = await js(`window.arcPower.startupGet()`);
    if (st.applyOnBoot === true || st.startWithWindows === true) await js(`window.arcPower.startupSet(false)`).catch(() => {});
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

  // Change the driver state THROUGH the OC UI (keeps the store honest - a
  // raw api.applySettings would bypass the store and break the no-op
  // comparison in the profile load), then load the profile: real change ->
  // exactly two success toasts (power + freq).
  await gotoOverclocking();
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

  // --- M4-D: the profile LOAD auto re-prompt + single retry -------
  // A NEVER-accepted session whose load hits waiver-not-set (the driver
  // lost the waiver, no consent is persisted): MAIN cannot silently re-set
  // (the store is unaccepted), so the failure surfaces - and the renderer
  // re-prompts ONCE (the fresh caps show the driver truth) + retries on
  // accept. The retry lands with REAL changes and exactly one dialog.
  // 1. Dirty the driver state through the OC UI (the session is accepted -
  //    no dialog) so the retry is a real change (the profile holds 210 W /
  //    0 MHz).
  await gotoOverclocking();
  await setSliderFor('powerLimitW', 220);
  await setSliderFor('gpuFreqOffsetMhz', 50);
  await clickApply();
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4-D: the retry-setup apply failed');
  await clearToasts();
  await js(`location.hash = '#/profiles'`);
  await sleep(250);
  // 2. The STORE loses the persisted acceptance (a never-accepted session)
  //    while the driver flag + renderer caps still say accepted - the load
  //    gate reads the caps (no gate dialog), the silent re-set in main
  //    reads the store (no auto re-set - the failure surfaces).
  await store.saveSettings({ ...(await store.loadSettings()), waiverAccepted: false });
  // 3. One-shot driver waiver loss on the profile apply.
  // M17d (Run D - the V1-call pin): the profile load apply is advanced-
  // gated, so its 210 W routes the V1 (extended) setters - the one-shot
  // waiver-not-set is injected on the extended path (the driverstore-path
  // injectFail cannot reach an advanced-mode W/C apply anymore).
  backend.injectFail('powerLimitW', 'waiver-not-set', true);
  const realExtWns = backend.extendedApply.bind(backend);
  let wnsInjected = false;
  backend.extendedApply = async (control, value) => {
    if (control === 'powerLimitW' && !wnsInjected) {
      wnsInjected = true;
      // G2 mirror: the mock's applySettings reconciles the in-memory waiver
      // flag on a driver waiver-not-set (getCapabilities then reports
      // unaccepted and the next apply re-shows the dialog) - the extended-
      // path wrap must mirror it (the V1 path bypasses applySettings).
      backend._reconcileWaiver({ perControl: { powerLimitW: { errorCode: 'waiver-not-set' } } }, 0);
      return { ok: false, errorCode: 'waiver-not-set', readBackEqual: false, message: 'waiver not set' };
    }
    return realExtWns(control, value);
  };
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
  //    (per-control apply semantics - the injected failure only hit
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
  backend.extendedApply = realExtWns;

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

  // ocOnBoot round trip (active profile = the copy). M4-D2: the toggle
  // reflects the applyOnBoot derivation (the shared Run value + ocOnBoot +
  // an active profile); the saved intent rides profiles-settings-save.
  await js(`document.querySelector('.boot-checkbox').click()`);
  if (!(await waitFor(win, `window.arcPower.startupGet().then((s) => s.applyOnBoot === true)`, 5000))) fail('start-at-boot ON did not compose applyOnBoot (mock)');
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.ocOnBoot === true)`, 5000))) fail('start-at-boot ON did not persist ocOnBoot=true');
  await js(`document.querySelector('.boot-checkbox').click()`);
  if (!(await waitFor(win, `window.arcPower.startupGet().then((s) => s.applyOnBoot === false)`, 5000))) fail('start-at-boot OFF did not clear the shared Run value');
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.ocOnBoot === false)`, 5000))) fail('start-at-boot OFF did not persist ocOnBoot=false');
  step('ocOnBoot', `start-at-boot toggle round trip via profiles-settings-save + the applyOnBoot derivation (profile ${await js(`window.arcPower.profilesList().then((e) => e.settings.activeProfileId)`)} active)`);
  await clearToasts();

  // --- Fix-round F1 + F3 (M4-D2 review 1): profiles-settings-save is the
  // --- ONLY Run-value writer; a failed toggle re-renders from startup-get --
  // F1: the value derives from the persisted intent and SELF-HEALS - ocOnBoot
  // on + the value dropped externally, a NON-toggle settings save re-writes
  // it (the old design never re-derived; the app silently stopped registering).
  const f1ActiveId = await js(`window.arcPower.profilesList().then((e) => e.settings.activeProfileId)`);
  if (!f1ActiveId) fail('F1: no active profile for the fix-round pin');
  await js(`window.arcPower.profilesSettingsSave({ ocOnBoot: true, activeProfileId: '${f1ActiveId}' })`);
  if (!(await waitFor(win, `window.arcPower.startupGet().then((s) => s.applyOnBoot === true)`, 5000))) fail('F1: enabling ocOnBoot through profiles-settings-save did not write the Run value');
  await js(`window.arcPower.startupSet(false)`); // simulate external deletion
  if (!(await waitFor(win, `window.arcPower.startupGet().then((s) => s.applyOnBoot === false)`, 5000))) fail('F1: setup - the value removal did not land');
  await js(`window.arcPower.profilesSettingsSave({ activeProfileId: '${f1ActiveId}' })`); // non-toggle save
  if (!(await waitFor(win, `window.arcPower.startupGet().then((s) => s.applyOnBoot === true)`, 5000))) fail('F1: a non-toggle settings save did not self-heal the Run value');
  // F3: a FAILED toggle-off (settings save throws) - the value write landed
  // (set-before-save), the intent did NOT change -> applyOnBoot stays false
  // while the persisted ocOnBoot stays true: the boot card must re-render
  // from startup-get (checkbox follows the derivation, mismatch hint shows).
  const realBootSave = store.saveSettings.bind(store);
  let failBootSave = false;
  store.saveSettings = async (settings) => {
    if (failBootSave && settings.ocOnBoot !== undefined) {
      throw new Error('injected boot-save failure (ui-verify)');
    }
    return realBootSave(settings);
  };
  await js(`location.hash = '#/dashboard'`);
  await js(`location.hash = '#/profiles'`);
  await sleep(250);
  failBootSave = true;
  await clearToasts();
  await js(`document.querySelector('.boot-checkbox').click()`);
  if (!(await waitFor(win, `!!document.querySelector('.toast-error')`, 5000))) fail('F3: the failed start-at-boot save did not surface the error toast');
  // The value write landed (set(false)), the intent did not -> the honest
  // re-render shows the checkbox OFF (applyOnBoot=false) + the mismatch hint.
  if (!(await waitFor(win, `document.querySelector('.boot-checkbox')?.checked === false`, 5000))) fail('F3: the boot checkbox did not follow the startup-get derivation after the failed save (catch must refresh)');
  if (!(await waitFor(win, `(document.getElementById('page')?.textContent ?? '').includes('disagree')`, 5000))) fail('F3: the mismatch hint did not re-render after the failed save (catch must refresh)');
  failBootSave = false;
  store.saveSettings = realBootSave;
  // Recovery: the next click lands (value + intent agree now).
  await clearToasts();
  await js(`document.querySelector('.boot-checkbox').click()`);
  if (!(await waitFor(win, `window.arcPower.startupGet().then((s) => s.applyOnBoot === true)`, 5000))) fail('F3: the recovery click after the failed toggle did not land applyOnBoot=true');
  // Restore the baseline (value off, ocOnBoot off - the state the rename/
  // delete steps below expect).
  await js(`window.arcPower.profilesSettingsSave({ ocOnBoot: false, activeProfileId: null })`);
  if (!(await waitFor(win, `window.arcPower.startupGet().then((s) => s.applyOnBoot === false)`, 5000))) fail('F3: the baseline restore (ocOnBoot off) did not land');
  step('f1f3-fixround', 'fix-round F1/F3: profiles-settings-save writes + self-heals the Run value (non-toggle save); a failed toggle re-renders the boot card from startup-get (honest checkbox + mismatch hint) and the next click recovers');

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

  // --- M4-H (B): the Save-as-Profile card flow (OC view) --------------------
  // Create flow: no profile applied -> the button reads 'Save as Profile';
  // the click opens the shared promptModal (EMPTY on create); the save
  // writes a NEW profile (ocOnBoot false) + a success toast + tray-rebuild.
  // Override flow: with the profile loaded (active), the button reads
  // 'Override Profile' and the click PRE-FILLS the modal with the applied
  // profile's name; the save OVERWRITES the ACTIVE profile (same id) and
  // carries its OWN ocOnBoot (never silently zeroed - N2). The reload
  // check: a fresh reload keeps the button on 'Override Profile' (the
  // activeProfileId persists).
  await js(`location.hash = '#/tuning'`);
  await sleep(250);
  if (!(await waitFor(win, `(document.querySelector('.oc-mode-row .profile-save-btn')?.textContent ?? '').trim() === 'Save as Profile'`, 5000))) {
    fail(`M4-H: the save button does not read 'Save as Profile' with no profile applied: '${await js(`document.querySelector('.oc-mode-row .profile-save-btn')?.textContent ?? ''`)}'`);
  }
  const m4hRowByName = (name) => `Array.from(document.querySelectorAll('.profile-row')).find((r) => (r.querySelector('.profile-name')?.textContent ?? '') === '${name}')`;
  const m4hClickRowButton = (name, label) => js(`(() => { const r = ${m4hRowByName(name)}; if (!r) return false; const b = Array.from(r.querySelectorAll('button')).find((b) => b.textContent.trim() === '${label}'); if (!b) return false; b.click(); return true; })()`);
  // Create: the modal opens EMPTY with the create title.
  await js(`document.querySelector('.profile-save-btn').click()`);
  if (!(await waitFor(win, `document.querySelector('.modal .modal-title')?.textContent === 'Save as Profile'`, 5000))) {
    fail(`M4-I: the save-button modal title is '${await js(`document.querySelector('.modal .modal-title')?.textContent ?? ''`)}' (expected 'Save as Profile' on create)`);
  }
  if ((await js(`document.querySelector('.modal-input')?.value ?? 'x'`) !== '')) fail('M4-H: the create modal must NOT be prefilled');
  await js(`(() => { const i = document.querySelector('.modal-input'); i.value = 'M4H saved profile'; })()`);
  await js(`document.querySelector('.modal button.btn-primary').click()`);
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4-I: the save-button create did not toast success');
  const createdM4h = await js(`window.arcPower.profilesList().then((e) => (e.profiles.find((p) => p.name === 'M4H saved profile') ?? null))`);
  if (!createdM4h) fail('M4-I: the save-button create did not write the profile');
  if (createdM4h.ocOnBoot !== false) fail(`M4-I: a created profile must have ocOnBoot false (got ${createdM4h.ocOnBoot})`);
  if (!createdM4h.settings || Object.keys(createdM4h.settings).length === 0) fail('M4-I: the created profile has no settings');
  const m4hCreatedId = createdM4h.id;
  step('m4h-save-create', `M4-H: save-card create flow - modal (empty) -> 'M4H saved profile' written (id '${m4hCreatedId}', ocOnBoot false, ${Object.keys(createdM4h.settings).length} settings keys) + success toast`);
  await clearToasts();
  // Load the profile (the real Profiles-page Load flow marks it active).
  await js(`location.hash = '#/profiles'`);
  await sleep(250);
  if (!(await m4hClickRowButton('M4H saved profile', 'Load'))) fail('M4-H: the profile Load button did not click');
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.activeProfileId === '${m4hCreatedId}')`, 5000))) {
    fail('M4-I: the load did not mark the profile active');
  }
  await js(`location.hash = '#/tuning'`);
  await sleep(250);
  if (!(await waitFor(win, `(document.querySelector('.oc-mode-row .profile-save-btn')?.textContent ?? '').trim() === 'Override Profile'`, 5000))) {
    fail(`M4-H: the save button does not read 'Override Profile' with the profile applied: '${await js(`document.querySelector('.oc-mode-row .profile-save-btn')?.textContent ?? ''`)}'`);
  }
  // Override: the modal PRE-FILLS the applied profile's name; saving
  // overwrites the ACTIVE id with the same ocOnBoot.
  await js(`document.querySelector('.profile-save-btn').click()`);
  if (!(await waitFor(win, `document.querySelector('.modal .modal-title')?.textContent === 'Override Profile'`, 5000))) {
    fail(`M4-I: the override modal title is '${await js(`document.querySelector('.modal .modal-title')?.textContent ?? ''`)}' (expected 'Override Profile')`);
  }
  if ((await js(`document.querySelector('.modal-input')?.value ?? ''`)) !== 'M4H saved profile') {
    fail(`M4-I: the override modal must be prefilled with the applied profile's name (got '${await js(`document.querySelector('.modal-input')?.value ?? ''`)}')`);
  }
  await js(`(() => { const i = document.querySelector('.modal-input'); i.value = 'M4H saved profile v2'; })()`);
  await js(`document.querySelector('.modal button.btn-primary').click()`);
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4-I: the save-button override did not toast success');
  const overridden = await js(`window.arcPower.profilesList().then((e) => (e.profiles.find((p) => p.id === '${m4hCreatedId}') ?? null))`);
  if (!overridden) fail(`M4-I: the override LOST the profile id '${m4hCreatedId}' (must overwrite the ACTIVE profile)`);
  if (overridden.name !== 'M4H saved profile v2') fail(`M4-I: the override did not rename the profile (name '${overridden.name}')`);
  await clearToasts();
  step('m4h-save-override', `M4-H: override flow - button 'Override Profile', modal prefilled, active id '${m4hCreatedId}' overwritten (name -> 'M4H saved profile v2')`);
  // Reload check: a FRESH reload keeps the active profile + the button.
  await js(`location.reload()`);
  if (!(await waitFor(win, `document.querySelectorAll('.sidebar-link').length === 7`, 15000))) {
    fail('M4-H: the reload did not boot the shell (7 sidebar links expected - the Overlay tab moved into Monitoring in M9)');
  }
  await js(`location.hash = '#/tuning'`);
  await sleep(300);
  if (!(await waitFor(win, `(document.querySelector('.oc-mode-row .profile-save-btn')?.textContent ?? '').trim() === 'Override Profile'`, 8000))) {
    fail(`M4-H: after a fresh reload the save button reads '${await js(`document.querySelector('.oc-mode-row .profile-save-btn')?.textContent ?? ''`)}' (expected 'Override Profile' - the activeProfileId persists)`);
  }
  step('m4h-save-reload', 'M4-H: fresh reload keeps the active profile -> the save button still reads "Override Profile"');

  // --- M4N (C): the active-profile TAG (the M4M card is REMOVED) ----------
  // The M4-H flow left the ACTIVE profile applied: the tuning page's mode
  // row must show the profile TAG ('Profile: M4H saved profile v2' - the
  // compact chip next to the save button; the M4M "Currently selected
  // profile" CARD with its Start-at-boot chip + settings count is GONE).
  // After the active slot is cleared below, the tag must be GONE entirely.
  if (await js(`!!document.querySelector('.active-profile-card')`)) {
    fail('M4N: the "Currently selected profile" card is still rendered (removed - the tag replaces it)');
  }
  if (!(await waitFor(win, `(document.querySelector('.profile-tag-row .active-profile-tag')?.textContent ?? '').trim() === 'Profile: M4H saved profile v2'`, 8000))) {
    fail(`M4N: the active-profile tag is missing/does not show the profile name: '${await js(`document.querySelector('.profile-tag-row .active-profile-tag')?.textContent ?? ''`)}'`);
  }
  if (await js(`(document.querySelector('.profile-tag-row .active-profile-tag')?.title ?? '') !== 'Currently selected profile'`)) {
    fail('M4N: the active-profile tag lacks the "Currently selected profile" tooltip');
  }
  step('m4n-active-tag', `M4N: the active-profile TAG shows 'Profile: M4H saved profile v2' (the M4M card is gone)`);

  // Cleanup the M4-H profile + clear the active slot.
  await js(`window.arcPower.profilesDelete('${m4hCreatedId}')`).catch(() => {});
  await js(`window.arcPower.profilesSettingsSave({ activeProfileId: null })`).catch(() => {});
  // No active profile -> the tag is ABSENT entirely (a re-render proves it -
  // the clear itself does not re-render the page).
  await js(`location.hash = '#/dashboard'`);
  await js(`location.hash = '#/tuning'`);
  if (!(await waitFor(win, `!!document.querySelector('.oc-mode-row')`, 5000))) fail('M4N: the tuning page did not re-render after the active-slot clear');
  await sleep(300);
  if (await js(`!!document.querySelector('.profile-tag-row .active-profile-tag')`)) {
    fail('M4N: the active-profile tag is still rendered after activeProfileId was cleared (must be absent entirely)');
  }
  step('m4n-active-tag-gone', 'M4N: no active profile -> the tag is absent entirely');
  await clearToasts();

  // M4J clarification (S1/F2 REVERTED): the upgrade-path pin is REMOVED -
  // a saved 1.0.3 profile carrying an extended PL applies on the a770 as
  // in 1.0.3 (gated by the OC-mode pill normally; the stock-mode refusal
  // path is already pinned by the M3-C-E stock variant above).
  step('m4j-ext-pl-103', 'M4J (clarification): a 1.0.3 extended-PL profile applies on the a770 as in 1.0.3 - gated by the OC-mode pill (the S1 force + the caps-level extended gate are reverted)');

  // --- 16. M3-A/M3-B Tweaks page: the catalog renders with the live (mock)
  // --- states; applyable entries get working Enable/Disable/Revert buttons
  // --- (mock apply - no elevation), fullscreen stays read-only ------------
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
    fail(`mpo state is '${await tweakStateOf('mpo')}' (expected 'Off' - the fixture default)`);
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

  // --- M4-D + M4-D2: the Settings tab ------------------------------
  // Start with Windows (the HKCU Run value via the MOCK startup adapter -
  // never spawns, never elevates), Start minimized (persisted), Close to
  // tray (persisted), Log to file (persisted monitorLogToFile), the app
  // version row.
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('.sidebar-link')).some((a) => (a.textContent ?? '').trim() === 'Settings')`))) {
    fail('M4-D: the sidebar has no Settings nav link');
  }
  await js(`location.hash = '#/settings'`);
  await sleep(250);
  // Version row (app:version via the header line's display format). M9: the
  // 1.1.1 base bump ('Arc Power Ver. 1.1.1 Alpha'); M10a: the 1.2.0 bump;
// M11: the 1.0 Release - no suffix (the "Alpha" scheme is gone). M17e
// (round-2 N1): the 1.0.1 bump joins the flips - the Settings row is the
// exact 'Arc Power Ver. 1.0.1' text (the M4-D row shares the header's
// display format).
if (!(await waitFor(win, `(document.querySelector('.settings-version')?.textContent ?? '').trim() === 'Arc Power Ver. 1.0.1'`))) {
fail(`M4-D: the Settings version row is '${await js(`document.querySelector('.settings-version')?.textContent ?? ''`)}' (expected 'Arc Power Ver. 1.0.1')`);
  }
  const startWithBox = `document.querySelector('.settings-checkbox[data-setting="startWithWindows"]')`;
  const startMinBox = `document.querySelector('.settings-checkbox[data-setting="startMinimized"]')`;
  const closeTrayBox = `document.querySelector('.settings-checkbox[data-setting="closeToTray"]')`;
  const logBox = `document.querySelector('.settings-checkbox[data-setting="monitorLogToFile"]')`;
  if (!(await js(`!!${startWithBox} && !!${startMinBox} && !!${closeTrayBox} && !!${logBox}`))) fail('M4-D: the Settings toggles did not render (incl. the M4-D2 Log to file toggle)');
  if (await js(`${startWithBox}.checked`)) fail('M4-D: Start with Windows is checked before anything enabled it');
  // Close to tray round trip (M4-D user): the checkbox persists
  // closeToTray through the profiles-settings-save channel; the REAL close
  // interception is pinned by the shared close-to-tray probe at the END of
  // every variant (win.close() on the live BrowserWindow).
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
  // (startMinimized) through the profiles-settings-save channel. M4J (G):
  // under RID_MOCK_START_MINIMIZED=1 the session SEEDED startMinimized:true
  // (the tray-start probe) - the round trip starts from the checked state
  // (click -> false, click -> true).
  if (process.env.RID_MOCK_START_MINIMIZED === '1') {
    if (!(await js(`${startMinBox}.checked`))) fail('M4J (G): the Start minimized checkbox is not checked in the seeded tray-start session');
    await js(`${startMinBox}.click()`);
    if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.startMinimized === false)`, 5000))) {
      fail('M4J (G): Start minimized did not persist startMinimized=false (seeded session)');
    }
    await js(`${startMinBox}.click()`);
    if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.startMinimized === true)`, 5000))) {
      fail('M4J (G): Start minimized did not persist startMinimized=true (seeded session)');
    }
    if (!(await js(`${startMinBox}.checked`))) fail('M4J (G): the Start minimized checkbox did not reflect its on state (seeded session)');
  } else {
    await js(`${startMinBox}.click()`);
    if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.startMinimized === true)`, 5000))) {
      fail('M4-D: Start minimized did not persist startMinimized=true');
    }
    if (!(await js(`${startMinBox}.checked`))) fail('M4-D: the Start minimized checkbox did not reflect its on state');
    await js(`${startMinBox}.click()`);
    if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.startMinimized === false)`, 5000))) {
      fail('M4-D: Start minimized did not persist startMinimized=false');
    }
  }
  // M4-D2 (§10): the Log to file round trip - the persisted monitorLogToFile
  // toggle. Gated on RID_MOCK_LOG_DIR: with the knob the appends land in the
  // mock dir (and the .txt log pins below run); without it the round trip is
  // SKIPPED so the verify never writes to the real Documents folder.
  if (process.env.RID_MOCK_LOG_DIR) {
    await js(`${logBox}.click()`);
    if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.monitorLogToFile === true)`, 5000))) {
      fail('M4-D2: Log to file did not persist monitorLogToFile=true');
    }
    await js(`${logBox}.click()`);
    if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.monitorLogToFile === false)`, 5000))) {
      fail('M4-D2: Log to file did not persist monitorLogToFile=false');
    }
  }
  step('m4d-settings-roundtrips', `Settings: Close to tray / Start minimized round trips persisted true/false via profiles-settings-save${process.env.RID_MOCK_LOG_DIR ? '; Log to file round trip persisted true/false' :     '; Log to file round trip SKIPPED (RID_MOCK_LOG_DIR not set)'}; version row 1.0.1`);

  // Start with Windows round trip + the honest shared-value state. The
  // Settings checkbox shows ON whenever the Run value exists - the profile's
  // start-at-boot (ocOnBoot) can own it (F6: never a false mismatch).
  await js(`window.arcPower.profilesSettingsSave({ ocOnBoot: true, activeProfileId: 'profile-1' })`);
  await js(`window.arcPower.startupSet(true)`);
  await js(`location.hash = '#/dashboard'`);
  await js(`location.hash = '#/settings'`);
  await sleep(250);
  // The checkbox is ON (the value exists - the profile owns it) + the
  // reworded hint explains the ownership.
  if (!(await waitFor(win, `${startWithBox}.checked === true`, 5000))) {
    fail('M4-D2: the Settings checkbox must show ON whenever the value exists (the profile start-at-boot owns it here)');
  }
  if (!(await waitFor(win, `(document.getElementById('page')?.textContent ?? '').includes('Apply active profile at boot is enabled')`, 5000))) {
    fail('M4-D2: the Settings card does not show the reworded apply-profile hint while the profile owns the value');
  }
  if (!(await waitFor(win, `(document.getElementById('page')?.textContent ?? '').includes('Arc Power starts at logon to apply it')`, 5000))) {
    fail('M4-D2: the apply-profile hint is missing its logon wording');
  }
  step('m4d-settings-owned', 'M4-D2 (F6): the profile start-at-boot owns the Run value -> Settings checkbox ON + the reworded "Apply active profile at boot is enabled" hint (no false mismatch)');
  // Disable the profile registration: the value comes off, the checkbox
  // follows.
  await js(`window.arcPower.startupSet(false)`);
  await js(`window.arcPower.profilesSettingsSave({ ocOnBoot: false, activeProfileId: null })`);
  await js(`location.hash = '#/dashboard'`);
  await js(`location.hash = '#/settings'`);
  await sleep(250);
  // Enabling Start with Windows writes the value + persists startWithWindows.
  await clearToasts();
  await js(`${startWithBox}.click()`);
  if (!(await waitFor(win, `window.arcPower.startupGet().then((s) => s.startWithWindows === true)`, 5000))) {
    fail('M4-D2: enabling Start with Windows did not compose startWithWindows=true');
  }
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.startWithWindows === true)`, 5000))) {
    fail('M4-D: Start with Windows did not persist startWithWindows=true');
  }
  if (!(await js(`${startWithBox}.checked`))) fail('M4-D: the Start with Windows checkbox did not reflect its on state');
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4-D: the Start with Windows enable did not toast success');
  // Toggle off: the value is removed (nothing else owns it) + persists false.
  await clearToasts();
  await js(`${startWithBox}.click()`);
  if (!(await waitFor(win, `window.arcPower.startupGet().then((s) => s.startWithWindows === false)`, 5000))) {
    fail('M4-D2: disabling Start with Windows did not remove the Run value');
  }
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.startWithWindows === false)`, 5000))) {
    fail('M4-D: Start with Windows did not persist startWithWindows=false');
  }
  step('m4d-settings-startwith', 'M4-D2: Start with Windows round trip (shared HKCU Run value + persisted startWithWindows true/false, zero tasks)');
  await clearToasts();

  // --- M4-D review F4: the PARTIAL-FAILURE honesty path (M4-D2 shape) ------
  // The value write lands but the settings save throws: the catch path must
  // re-query startup-get so the card re-renders from the DERIVED state
  // (never a blindly reverted checkbox that lies - the derivation is the
  // truth the startup-get channel composes). The settings-save failure is
  // injected by wrapping the SESSION store's saveSettings - the very store
  // the IPC handler writes through.
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
  // The value write lands; the settings save fails honestly.
  if (!(await waitFor(win, `window.arcPower.startupGet().then((s) => s.applyOnBoot === false)`, 5000))) {
    fail('M4-D: the partial-failure setup left the derivation dirty');
  }
  if (!(await waitFor(win, `!!document.querySelector('.toast-error')`, 5000))) {
    fail('M4-D: the partial-failure settings save did not surface the honest error toast');
  }
  // The card re-rendered from startup-get (no crash, the checkbox follows
  // the DERIVED truth - settings still say false, so the value the write
  // landed is not composable into startWithWindows; the honest error toast
  // is the surfaced truth, and the next click recovers).
  if (!(await waitFor(win, `!!${startWithBox}`, 5000))) {
    fail('M4-D: the Settings card vanished after the partial failure');
  }
  failSettingsSave = false;
  store.saveSettings = realSaveSettings;
  // Recovery: the next click lands (value + settings agree now).
  await clearToasts();
  await js(`${startWithBox}.click()`);
  if (!(await waitFor(win, `window.arcPower.startupGet().then((s) => s.startWithWindows === true)`, 5000))) {
    fail('M4-D: the recovery click after the partial failure did not land startWithWindows=true');
  }
  if (!(await waitFor(win, `${startWithBox}.checked === true`, 5000))) {
    fail('M4-D: the recovery click did not flip the checkbox');
  }
  // Restore the baseline (off).
  await js(`${startWithBox}.click()`);
  if (!(await waitFor(win, `window.arcPower.startupGet().then((s) => s.startWithWindows === false)`, 5000))) {
    fail('M4-D: the baseline restore (startWithWindows=false) did not land');
  }
  step('m4d-settings-partial', 'M4-D: partial failure (value written, settings save failed) -> honest error toast, the card re-rendered from startup-get (derivation truth), the next click recovered (startWithWindows true + checkbox on), baseline restored');
  await clearToasts();

  // --- M4-D2: the mock boot-apply flow probe (the REAL window-path boot
  // --- apply, applyRunner-less) -------------------------------------------
  // A real profile in the store + ocOnBoot + an active profile id -> the
  // mock channel runs the REAL boot-apply code path and records the attempt
  // in the session mock apply log: applied with NO refusal. The persisted
  // acceptance is seeded (the M4-D profiles-retry section above deliberately
  // flipped the store to false mid-run; the DEVICE-side waiver is accepted
  // in every variant by this point - this seed mirrors a real accepted
  // session).
  await store.saveSettings({ ...(await store.loadSettings()), waiverAccepted: true });
  const bootProbeProfile = await js(`window.arcPower.profilesSave({ id: 'boot-probe', name: 'boot-probe', settings: { powerLimitW: 210 }, ocOnBoot: false })`);
  if (!(bootProbeProfile?.profiles ?? []).some((p) => p.id === 'boot-probe')) fail('M4-D2: the boot-probe profile was not created');
  await js(`window.arcPower.profilesSettingsSave({ ocOnBoot: true, activeProfileId: 'boot-probe' })`);
  const bootOut = await js(`window.arcPower.mockRunBootApply()`);
  if (bootOut.applied !== true) {
    fail(`M4-D2: the mock boot apply did not land: ${JSON.stringify(bootOut)}`);
  }
  if (bootOut.reason) fail(`M4-D2: the mock boot apply recorded a refusal reason: '${bootOut.reason}'`);
  const bootLog = await js(`window.arcPower.mockBootApplyLog()`);
  const lastEntry = Array.isArray(bootLog) ? bootLog[bootLog.length - 1] : null;
  if (!lastEntry || lastEntry.profileId !== 'boot-probe' || lastEntry.applied !== true || lastEntry.reason !== null) {
    fail(`M4-D2: the mock boot-apply log does not record the active profile apply with no refusal: ${JSON.stringify(bootLog)}`);
  }
  step('m4d2-boot-apply', `mock boot-apply: the REAL boot-apply flow applied the active profile ('boot-probe') with no refusal; the mock apply log records { profileId: 'boot-probe', applied: true, reason: null }`);
  await js(`window.arcPower.profilesSettingsSave({ ocOnBoot: false, activeProfileId: null })`);
  await js(`window.arcPower.profilesDelete('boot-probe')`).catch(() => {});

  // --- 1.0.1 Themes: the Settings Theme card -------------------------------
  // Placed AFTER the boot-probe section: the store is ACCEPTED here, so the
  // fresh reload below re-boots WITHOUT the waiver prompt (M4-D permanent
  // acceptance) and the persisted theme must survive a REAL renderer reload
  // (M3 - the boot sequence re-applies it from the envelope). The pins:
  //   1. the card renders 3 swatches (button[data-theme-option=...]) with
  //      class-driven color chips (CSP-safe) and the current theme marked
  //      .active;
  //   2. selecting Midnight flips the <html> attribute AND the COMPUTED
  //      --bg (getComputedStyle - the equal-specificity ordering hazard,
  //      N9) + persists (profiles-settings-save) + the swatch goes active;
  //   3. a FRESH RELOAD re-applies the persisted Midnight at boot;
  //   4. selecting Light too (its own computed --bg), then back to Dark;
  //   5. the final step asserts the PERSISTED settings.theme === 'dark'
  //      (M2 - the session must leave the shared mock dir on the default,
  //      like the ocMode/waiver seeds).
  await js(`location.hash = '#/settings'`);
  await sleep(250);
  const themeOption = (t) => `document.querySelector('.theme-option[data-theme-option="${t}"]')`;
  if (!(await waitFor(win, `document.querySelectorAll('.theme-option').length === 3`, 5000))) {
    fail(`1.0.1: the Theme card renders ${await js(`document.querySelectorAll('.theme-option').length`)} swatches (expected 3)`);
  }
  for (const t of ['dark', 'midnight', 'light']) {
    if (!(await js(`!!${themeOption(t)}`))) fail(`1.0.1: the Theme card has no ${t} swatch`);
    if (!(await js(`!!document.querySelector('.swatch-chip.swatch-${t}')`))) fail(`1.0.1: the ${t} swatch has no class-driven color chip`);
  }
  if (!(await js(`${themeOption(bootTheme)}.classList.contains('active')`))) {
    fail(`1.0.1: the current (${bootTheme}) swatch is not marked active`);
  }
  step('themes-card', `1.0.1: Theme card renders the 3 swatches (dark/midnight/light, class-driven chips) with the current one ('${bootTheme}') active`);

  // Midnight: attribute + computed --bg + persisted + active swatch.
  await js(`${themeOption('midnight')}.click()`);
  if (!(await waitFor(win, `document.documentElement.dataset.theme === 'midnight'`, 5000))) {
    fail(`1.0.1: selecting Midnight did not set the attribute (is '${await js(`document.documentElement.dataset.theme ?? ''`)}')`);
  }
  if (!(await waitFor(win, `getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() === '#0b1020'`, 5000))) {
    fail(`1.0.1: selecting Midnight did not change the computed --bg (is '${await js(`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`)}')`);
  }
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.theme === 'midnight')`, 5000))) {
    fail('1.0.1: selecting Midnight did not persist theme=midnight');
  }
  if (!(await js(`${themeOption('midnight')}.classList.contains('active')`))) fail('1.0.1: the Midnight swatch is not active after selection');
  if (await js(`${themeOption('dark')}.classList.contains('active')`)) fail('1.0.1: the Dark Steel swatch is still active after selecting Midnight');
  step('themes-midnight', '1.0.1: Midnight selected -> <html> attribute + computed --bg (#0b1020) + persisted theme=midnight + active swatch');

  // Fresh reload: the persisted theme re-applies at BOOT (M3) - a real
  // webContents reload re-runs the renderer boot sequence end to end.
  await win.webContents.reload();
  if (!(await waitFor(win, `document.documentElement.dataset.theme === 'midnight'`, 10000))) {
    fail(`1.0.1: after a fresh reload the boot theme is '${await js(`document.documentElement.dataset.theme ?? ''`)}' (expected 'midnight' - the persisted theme must survive a reload)`);
  }
  if (!(await waitFor(win, `getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() === '#0b1020'`, 8000))) {
    fail('1.0.1: the reloaded boot did not resolve the midnight computed --bg');
  }
  step('themes-reload', '1.0.1: fresh reload -> the persisted Midnight theme re-applied at boot (attribute + computed --bg)');

  // Light: attribute + computed --bg (the Arctic palette) + persisted.
  await js(`location.hash = '#/settings'`);
  await sleep(250);
  if (!(await waitFor(win, `document.querySelectorAll('.theme-option').length === 3`, 5000))) fail('1.0.1: the Theme card did not re-render after the reload');
  if (!(await js(`${themeOption('midnight')}.classList.contains('active')`))) fail('1.0.1: the Midnight swatch is not active after the reload round trip');
  await js(`${themeOption('light')}.click()`);
  if (!(await waitFor(win, `document.documentElement.dataset.theme === 'light'`, 5000))) fail('1.0.1: selecting Light did not set the attribute');
  if (!(await waitFor(win, `getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() === '#f2f4f8'`, 5000))) {
    fail(`1.0.1: selecting Light did not change the computed --bg (is '${await js(`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`)}')`);
  }
  // 1.0.1 contrast regression pin (final-review round): the light theme's
  // --on-accent must be white so .btn-primary/.oc-mode-btn.active text stays
  // readable on the darkened accent (a revert of the contrast fix breaks
  // this pin, not just the palette values).
  if (!(await waitFor(win, `getComputedStyle(document.documentElement).getPropertyValue('--on-accent').trim() === '#ffffff'`, 5000))) {
    fail(`1.0.1: the light theme --on-accent is not white (is '${await js(`getComputedStyle(document.documentElement).getPropertyValue('--on-accent').trim()`)}')`);
  }
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.theme === 'light')`, 5000))) fail('1.0.1: selecting Light did not persist theme=light');
  step('themes-light', '1.0.1: Light selected -> attribute + computed --bg (#f2f4f8) + persisted theme=light');

  // Back to Dark - the final step leaves the session + persisted store on
  // the default theme (M2: a leaked light theme must never bleed into a
  // later variant).
  await js(`${themeOption('dark')}.click()`);
  if (!(await waitFor(win, `document.documentElement.dataset.theme === 'dark'`, 5000))) fail('1.0.1: selecting Dark Steel did not set the attribute');
  if (!(await waitFor(win, `getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() === '#0f1116'`, 5000))) {
    fail(`1.0.1: selecting Dark Steel did not restore the computed --bg (is '${await js(`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`)}')`);
  }
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.theme === 'dark')`, 5000))) {
    fail('1.0.1: the final theme save did not persist theme=dark (M2: the mock session must end on the default theme)');
  }
  step('themes-dark-final', '1.0.1: back to Dark Steel -> attribute + computed --bg (#0f1116) + persisted theme=dark (the session ends on the default)');
  await clearToasts();

  // --- M4-D2/M4J: the log-to-file pin (RID_MOCK_LOG_DIR only) --------------
  // Toggle on -> the .txt appears with the pinned aligned 12-column header
  // + >= 1 parseable data line (the timestamp cell derives from sample.t
  // via Date(t*1000) - the mock epoch 9662.768701+ renders 1970-01-01, the
  // pinned value); toggle off -> appends stop (file length stable across a
  // telemetry tick).
  if (process.env.RID_MOCK_LOG_DIR) {
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    const logDir = process.env.RID_MOCK_LOG_DIR;
    const txtFiles = () => fsMod.readdirSync(logDir).filter((f) => f.startsWith('monitor-') && f.endsWith('.txt'));
    // Clean slate.
    for (const f of txtFiles()) fsMod.rmSync(pathMod.join(logDir, f), { force: true });
    await clearToasts();
    await js(`${logBox}.click()`);
    if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.monitorLogToFile === true)`, 5000))) {
      fail('M4-D2: the log toggle did not persist monitorLogToFile=true (pin setup)');
    }
    // The boot-level subscription appends on every telemetry push (0.5 s) -
    // the file appears with the header + data lines.
    const fileOk = await waitFor(win, `true`, 6000).then(() => {
      // poll the filesystem from the MAIN side (the renderer cannot read it)
      return (async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 6000) {
          const files = txtFiles();
          if (files.length > 0) {
            const content = fsMod.readFileSync(pathMod.join(logDir, files[0]), 'utf8');
            const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
            if (lines.length >= 2) return { file: files[0], lines };
          }
          await sleep(300);
        }
        return null;
      })();
    });
    if (!fileOk) fail(`M4-D2: the .txt log file did not appear with data lines in ${logDir}`);
    const header = fileOk.lines[0];
    // M4J/M4M: the pinned aligned header - every field right-aligned to its
    // column, ' | ' separators (the exact byte-for-byte pin). M4M (C): the
    // VRAM-used column is the GB variant (gpuMemUsedGb, width 12).
    const expectedHeader = '          timestamp | gpuClockMhz | memClockMhz | tempC | powerW | utilPct | fanRpm | cpuUtilPct | cpuTempC | cpuFreqMhz | gpuMemUsedGb | fps';
    if (header !== expectedHeader) fail(`M4J: the log header is '${header}' (expected the pinned aligned 12-column header)`);
    for (const line of fileOk.lines.slice(1)) {
      const fields = line.split(' | ');
      if (fields.length !== 12) fail(`M4J: a log data line has ${fields.length} columns (expected 12): '${line}'`);
      const ts = fields[0].trim();
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts)) {
        fail(`M4J: the timestamp cell is not the pinned 'YYYY-MM-DD HH:MM:SS' format: '${ts}'`);
      }
      if (!ts.startsWith('1970-01-01')) {
        fail(`M4J: the timestamp cell is '${ts}' (expected the mock epoch value's 1970-01-01 date - sample.t via Date(t*1000))`);
      }
    }
    const sampleLine = fileOk.lines[1];
    const sampleFields = sampleLine.split(' | ').map((s) => s.trim());
    // M4-I (C1): the mock temp VARIES 61/62 - the cell accepts either;
    // under RID_MOCK_FROZEN_TEMP=1 the shared frozenDrop trips to null, so
    // the honest '-' cell is the pinned state there (the log writes the
    // same sample the monitoring tile reads - the frozen '-' pin above).
    // M4M (C): the VRAM-used cell reads decimal GB with one decimal ('3.0'
    // for the mock's 2971324416 bytes - never a bare '3').
    const frozenLog = process.env.RID_MOCK_FROZEN_TEMP === '1';
    if (sampleFields[7] !== '42'
      || (!frozenLog && sampleFields[8] !== '61' && sampleFields[8] !== '62')
      || (frozenLog && sampleFields[8] !== '-')) {
      fail(`M4-D2/M4-I: the log data line does not carry the mock system stats (cpuUtilPct 42, cpuTempC ${frozenLog ? '"-" (frozen drop)' : '61|62'}): '${sampleLine}'`);
    }
    if (sampleFields[10] !== '3.0') fail(`M4M: the gpuMemUsedGb cell is '${sampleFields[10]}' on the mock line (expected '3.0' - 2971324416 bytes / 1e9 with one decimal): '${sampleLine}'`);
    // Toggle off -> the file length stays stable across a telemetry tick.
    await js(`location.hash = '#/settings'`);
    await sleep(250);
    await js(`${logBox}.click()`);
    if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.monitorLogToFile === false)`, 5000))) {
      fail('M4-D2: the log toggle did not persist monitorLogToFile=false (pin teardown)');
    }
    const before = fsMod.statSync(pathMod.join(logDir, fileOk.file)).size;
    await sleep(1800); // > 3 telemetry ticks
    const after = fsMod.statSync(pathMod.join(logDir, fileOk.file)).size;
    if (after !== before) fail(`M4-D2: the log file kept growing after the toggle was OFF (${before} -> ${after} bytes)`);
    step('m4j-log-file', `log-to-file: ${fileOk.file} appeared with the aligned 12-column header (gpuMemUsedGb) + ${fileOk.lines.length - 1} parseable line(s) (timestamp 1970-01-01 from the mock epoch via Date(t*1000), cpuUtilPct=42, cpuTempC=${process.env.RID_MOCK_FROZEN_TEMP === '1' ? '-' : '61'}, gpuMemUsedGb='3.0'); toggle off -> length stable (${before} bytes)`);
  } else {
    step('m4j-log-file', 'log-to-file pin SKIPPED (RID_MOCK_LOG_DIR not set)');
  }

  // --- M4-D2 (§1): the close-to-tray REAL close probe - the LAST step. -----
  await runCloseToTrayProbe(win);

  console.log('\nUI VERIFY OK\n' + steps.map((s) => '  ' + s).join('\n'));
  app.exit(0);
}

// ---------------------------------------------------------------------------
// M8 - the Graphics tab verify block (the MOCK backend: the page reads the
// mock fixture - never hardware)
// ---------------------------------------------------------------------------
//
// Pins the four cards (the planned order) + the fixture values, the
// driver-gated dropdown options (no Speed Sync - the live caps; the M9 On
// + Boost change makes the Low Latency list FULL off/on/on-boost), the
// FPS toggle OFF->no slider / ON->the range-driven slider, the
// dirty Apply + the mock round trip + the "Applied" chip, the per-card
// Apply button (M9: the chip state machine - a change reveals the card's
// .oc-chip-apply, its click applies that card only, the green 'Applied'
// chip replaces it, a further change brings the button back; the old
// 'Unapplied' warn chip is GONE), the Reset-to-default lifecycle (change
// -> dirty, reset -> clean, apply -> Applied, reset after apply -> the
// Apply button), the honest unsupported state
// (RID_MOCK_GRAPHICS_UNSUPPORTED=1), and the multi-device device-switch
// degrade (the iGPU serves the supported-all-false state - a device switch
// must never crash). The no-Intel guard pin lives in runNoIntelVerify (the
// renderer NEVER calls graphics:get with a null deviceId - assertValidDeviceId
// throws).
//
// @param {import('electron').BrowserWindow} win
// @param {object} backend the active (mock) backend
export async function runGraphicsVerify(win, backend) {
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

  // CSS-SELECTOR helper (NEVER an expression): the class names contain
  // dashes, so `document.querySelector(...) .card-note` would parse as a
  // subtraction (`card - note`) - every descendant lookup goes through a
  // real selector string.
  const cardSel = (control) => `.graphics-card[data-control="${control}"]`;
  const cardNote = (control) => `document.querySelector('${cardSel(control)} .card-note')?.textContent ?? ''`;

  // --- 1. the tab sits directly below Tuning + the page renders -------------
  // The boot sequence (health -> devices -> deviceId) is async - wait for
  // the device resolution to land before navigating (the page's deviceId
  // guard would otherwise show the honest 'No GPU available.' race state;
  // the initial 'Arc Power' placeholder must NOT satisfy the wait).
  if (!(await waitFor(win, `(() => { const n = (document.querySelector('.gpu-name')?.textContent ?? '').trim(); return n.includes('Arc A770') || n === 'Non supported GPU' || n.includes('AMD Radeon'); })()`, 10000))) {
    fail(`M8: the boot device resolution never landed (header '${await js(`document.querySelector('.gpu-name')?.textContent ?? ''`)}')`);
  }
  const navOrder = await js(`JSON.stringify(Array.from(document.querySelectorAll('.sidebar-nav .sidebar-link-label')).map((l) => (l.textContent ?? '').trim()))`);
  const navLabels = JSON.parse(navOrder);
  if (navLabels.indexOf('Graphics') !== navLabels.indexOf('Tuning') + 1) {
    fail(`M8: the Graphics tab must sit DIRECTLY BELOW Tuning (nav order '${navOrder}')`);
  }
  await js(`location.hash = '#/graphics'`);
  await sleep(250);

  // --- 1a. the unsupported variant (RID_MOCK_GRAPHICS_UNSUPPORTED=1) ---------
  // The knob runs the WHOLE session degraded (the RID_MOCK_FAN_READONLY
  // pattern - main.js passes it to the mock at construction): all four
  // cards show the honest 'Not supported on this GPU.' state with NO
  // controls. The supported-flow pins below cannot run in this session.
  if (process.env.RID_MOCK_GRAPHICS_UNSUPPORTED === '1') {
    if (!(await waitFor(win, `document.querySelectorAll('.graphics-card').length === 4 && Array.from(document.querySelectorAll('.graphics-card')).every((c) => (c.textContent ?? '').includes('Not supported on this GPU.'))`, 8000))) {
      fail(`M8: the RID_MOCK_GRAPHICS_UNSUPPORTED variant must show the honest 'Not supported on this GPU.' state on all four cards (page='${(await js(`(document.getElementById('page')?.textContent ?? '').slice(0, 200)`)).slice(0, 200)}')`);
    }
    if (await js(`!!document.querySelector('.graphics-select')`)) {
      fail('M8: the unsupported variant must render NO controls');
    }
    if (await js(`!!document.querySelector('.floating-apply') && !document.querySelector('.floating-apply').hidden`)) {
      fail('M8: the unsupported variant must not show the floating Apply (nothing to apply)');
    }
    step('m8-unsupported', 'M8 (RID_MOCK_GRAPHICS_UNSUPPORTED=1): all four cards show the honest "Not supported on this GPU." state, no controls, no Apply');
    return;
  }

  if (!(await waitFor(win, `document.querySelectorAll('.graphics-card').length === 4`, 8000))) {
    fail(`M8: the Graphics page did not render four cards (got ${await js(`document.querySelectorAll('.graphics-card').length`)} - page='${(await js(`(document.getElementById('page')?.textContent ?? '').slice(0, 160)`)).slice(0, 160)}')`);
  }
  const titles = await js(`JSON.stringify(Array.from(document.querySelectorAll('.graphics-card .card-title')).map((t) => (t.textContent ?? '').trim()))`);
  const wantTitles = ['XeSS Frame Generation Override', 'Frame Synchronization', 'FPS Limit', 'Low Latency Mode'];
  if (JSON.stringify(JSON.parse(titles)) !== JSON.stringify(wantTitles)) {
    fail(`M8: the card order is ${titles} (expected ${JSON.stringify(wantTitles)} - the planned order)`);
  }
  // The honest notes render (the Smart-VSync-out note on the Frame Sync card).
  const flipNote = await js(cardNote('flipMode'));
  if (!flipNote.includes('Smart VSync is not exposed')) {
    fail(`M8: the Frame Sync note must carry the Smart-VSync-out honesty: '${flipNote}'`);
  }
  if (!(await js(`document.body.textContent.includes('Per-game profiles stay in Intel Graphics Software')`))) {
    fail('M8: the page-level honest note (per-game profiles stay in IGS) is missing');
  }
  step('m8-cards', `M8: #/graphics renders the four cards in the planned order ${JSON.stringify(wantTitles)}; the Frame Sync note carries the Smart-VSync-out honesty; the page-level IGS note is present`);

  // --- 2. the fixture values + the driver-gated options ----------------------
  const fixtureValues = await js(`JSON.stringify({
    fg: document.querySelector('.graphics-select[data-graphics-select="frameGenOverride"]')?.value,
    flip: document.querySelector('.graphics-select[data-graphics-select="flipMode"]')?.value,
    ll: document.querySelector('.graphics-select[data-graphics-select="lowLatency"]')?.value,
  })`);
  const fv = JSON.parse(fixtureValues);
  if (fv.fg !== 'app-choice' || fv.flip !== 'application-default' || fv.ll !== 'off') {
    fail(`M8: the dropdowns do not show the mock fixture values: ${fixtureValues}`);
  }
  // The dropdown options mirror the LIVE caps (the probe record): no
  // Speed Sync (the flip caps 0x6f lack the bit), all four FG options.
  // M9 (the On + Boost fix): the Low Latency list is the FULL off/on/
  // on-boost on every driver (the option is no longer driver-gated - what
  // hid it was the M8 caps 0x3 lacking the boost bit; the backend set of
  // on-boost on such a driver still refuses honestly).
  const flipOptions = await js(`JSON.stringify(Array.from(document.querySelectorAll('.graphics-select[data-graphics-select="flipMode"] option')).map((o) => o.value))`);
  const llOptions = await js(`JSON.stringify(Array.from(document.querySelectorAll('.graphics-select[data-graphics-select="lowLatency"] option')).map((o) => o.value))`);
  if (JSON.parse(flipOptions).includes('speed-frame')) {
    fail(`M8: the Frame Sync dropdown offers Speed Sync, but the mock caps (the live 0x6f) do not expose the bit: ${flipOptions}`);
  }
  if (!JSON.parse(llOptions).includes('on-boost')) {
    fail(`M9: the Low Latency dropdown must offer On + Boost (the option is no longer driver-gated - the M9 optionsOf change): ${llOptions}`);
  }
  if (JSON.parse(await js(`JSON.stringify(Array.from(document.querySelectorAll('.graphics-select[data-graphics-select="frameGenOverride"] option')).map((o) => o.value))`)).length !== 4) {
    fail('M8: the FG dropdown must offer all four override options');
  }
  // The draft equals the driver state -> the floating Apply is HIDDEN.
  if (!(await js(`!!document.querySelector('.floating-apply') && document.querySelector('.floating-apply').hidden`))) {
    fail('M8: the floating Apply must be HIDDEN while the draft equals the driver state');
  }
  // M9: pristine cards carry the hidden chip + no per-card Apply button
  // (the CSS [hidden] fix makes the empty pill truly invisible); the old
  // 'Unapplied' chip text must not exist anywhere in the DOM.
  if (!(await js(`Array.from(document.querySelectorAll('.graphics-card')).every((c) => {
    const chip = c.querySelector('.oc-chip-status');
    const btn = c.querySelector('.oc-chip-apply');
    return !!chip && chip.hidden && (!btn || btn.hidden);
  })`))) {
    fail('M9: a pristine Graphics card must carry the hidden chip and no VISIBLE .oc-chip-apply button');
  }
  if (await js(`document.body.textContent.includes('Unapplied')`)) fail('M9: the "Unapplied" chip text must not exist anywhere in the DOM');
  step('m9-fixture', `M9: dropdowns show the fixture (fg '${fv.fg}', flip '${fv.flip}', ll '${fv.ll}'); options are driver-gated (no speed-frame in ${flipOptions}, the FULL on-boost list in ${llOptions}); the Apply stays hidden while clean; pristine cards carry only the hidden chip`);

  // --- 3. the FPS dropdown: Off -> the WHOLE slider-row hides (the value
  // --- text included - the M17c "30 FPS" text bug); On -> both appear ---
  const fpsToggle = `${cardSel('frameLimit')} .graphics-toggle`;
  const fpsSlider = `${cardSel('frameLimit')} .graphics-slider`;
  const fpsSliderRow = `${cardSel('frameLimit')} .graphics-fps-slider-row`;
  // M17c: the ON/OFF checkbox became a DROPDOWN ('FPS Limit Off' / 'FPS
  // Limit On' - the user's exact wording; no label text next to it) - the
  // draft { enabled, value } shape is UNCHANGED.
  if (!(await js(`(() => { const s = document.querySelector('${fpsToggle}'); return !!s && s.tagName === 'SELECT' && s.value === 'off' && JSON.stringify(Array.from(s.options).map((o) => o.value)) === '["off","on"]' && Array.from(s.options).every((o) => o.textContent.trim().startsWith('FPS Limit')); })()`))) {
    fail('M17c: the FPS limiter must render as a "FPS Limit Off"/"FPS Limit On" dropdown (the checkbox is gone), starting at Off');
  }
  if (!(await js(`(() => { const r = document.querySelector('${fpsSliderRow}'); return !!r && r.hidden; })()`))) {
    fail('M17c: the FPS slider-row (slider AND value text) must be HIDDEN while the limiter is OFF');
  }
  if (!(await js(`(() => { const v = document.querySelector('${cardSel('frameLimit')} .graphics-fps-value'); return !!v && v.offsetParent === null; })()`))) {
    fail('M17c: the "30 FPS" value text must NOT be visible while the limiter is OFF (the whole row hides)');
  }
  await js(`(() => { const s = document.querySelector('${fpsToggle}'); s.value = 'on'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  if (!(await waitFor(win, `(() => { const r = document.querySelector('${fpsSliderRow}'); const s = document.querySelector('${fpsSlider}'); return !!r && !r.hidden && !!s && !s.hidden && s.min === '30' && s.max === '300' && s.step === '1'; })()`, 5000))) {
    fail(`M17c: the FPS dropdown ON did not reveal the slider-row with the range-driven slider (min/max/step ${await js(`(() => { const s = document.querySelector('${fpsSlider}'); return s ? s.min + '/' + s.max + '/' + s.step : 'no-slider'; })()`)} - expected 30/300/1 from the mock range)`);
  }
  if (!(await js(`(() => { const v = document.querySelector('${cardSel('frameLimit')} .graphics-fps-value'); return !!v && v.offsetParent !== null && (v.textContent ?? '').endsWith(' FPS'); })()`))) {
    fail('M17c: the FPS value text must be visible again while the limiter is ON');
  }
  // The dropdown change dirtied the draft -> the floating Apply appears.
  if (!(await waitFor(win, `!!document.querySelector('.floating-apply') && !document.querySelector('.floating-apply').hidden`, 5000))) {
    fail('M17c: the FPS dropdown ON must dirty the draft (the floating Apply appears)');
  }
  step('m8-fps-toggle', 'M17c: FPS limiter dropdown ("FPS Limit Off"/"FPS Limit On", no label text) - Off hides the WHOLE slider-row (slider + the value text); On reveals the range-driven slider (30/300/1) + the value text + the dirty Apply');

  // --- 4. a change -> the dirty Apply appears; Apply -> the round trip ------
  await js(`(() => {
    const s = document.querySelector('.graphics-select[data-graphics-select="flipMode"]');
    s.value = 'vsync-on';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  // The chip stays hidden until the first apply (the M9 machine: a never-
  // applied change is the DIRTY state - the per-card Apply button shows).
  if (!(await js(`(() => { const c = document.querySelector('${cardSel('flipMode')} .oc-chip-status'); return !!c && c.hidden; })()`))) {
    fail('M8: the chip must stay hidden until the first apply');
  }
  if (!(await waitFor(win, `(() => { const b = document.querySelector('${cardSel('flipMode')} .oc-chip-apply'); return !!b && !b.hidden; })()`, 5000))) {
    fail('M9: changing the Frame Sync dropdown must reveal its .oc-chip-apply button');
  }
  await clearToasts();
  await js(`document.querySelector('.floating-apply').click()`);
  if (!(await waitFor(win, `(() => { const c = document.querySelector('${cardSel('flipMode')} .oc-chip-status'); return !!c && !c.hidden && (c.textContent ?? '').trim() === 'Applied' && c.className.includes('chip-ok'); })()`, 8000))) {
    fail(`M8: the mock round trip did not flip the Frame Sync chip to 'Applied' (chip='${await js(`document.querySelector('${cardSel('flipMode')} .oc-chip-status')?.textContent ?? ''`)}', driver flip='${(await js(`window.arcPower.graphicsGet(0)`)).values.flipMode}')`);
  }
  if (!(await waitFor(win, `document.querySelector('.floating-apply').hidden`, 8000))) {
    fail('M8: the floating Apply must hide after a successful apply (the applied reference cleared the dirty state)');
  }
  const appliedDriver = await js(`window.arcPower.graphicsGet(0)`);
  if (appliedDriver.values.flipMode !== 'vsync-on') {
    fail(`M8: the mock driver state did not reflect the apply (flip='${appliedDriver.values.flipMode}')`);
  }
  step('m8-round-trip', 'M8: change -> dirty Apply appears; Apply -> the mock round trip -> the Frame Sync chip reads "Applied" (chip-ok), the Apply hides, graphicsGet reflects flipMode=vsync-on');

  // --- 4b. M9: the per-card Apply button (the chip state machine) ----------
  // The per-card .oc-chip-apply applies THAT card only (the same
  // graphics:apply channel with the single key); after the round trip the
  // card shows the green 'Applied' chip + the button hides; changing the
  // same setting again brings the button back; applying again restores the
  // clean state (the FPS section below expects only its own dirty control).
  await js(`(() => {
    const s = document.querySelector('.graphics-select[data-graphics-select="flipMode"]');
    s.value = 'vsync-off';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  if (!(await waitFor(win, `(() => { const b = document.querySelector('${cardSel('flipMode')} .oc-chip-apply'); return !!b && !b.hidden; })()`, 5000))) {
    fail('M9: changing the Frame Sync dropdown again must reveal its .oc-chip-apply button');
  }
  await clearToasts();
  await js(`document.querySelector('${cardSel('flipMode')} .oc-chip-apply').click()`);
  if (!(await waitFor(win, `(() => { const c = document.querySelector('${cardSel('flipMode')} .oc-chip-status'); return !!c && !c.hidden && (c.textContent ?? '').trim() === 'Applied' && c.className.includes('chip-ok'); })()`, 8000))) {
    fail(`M9: the per-card apply did not flip the Frame Sync chip to 'Applied' (driver flip='${(await js(`window.arcPower.graphicsGet(0)`)).values.flipMode}')`);
  }
  if (!(await waitFor(win, `(() => { const b = document.querySelector('${cardSel('flipMode')} .oc-chip-apply'); return !!b && b.hidden; })()`, 5000))) {
    fail('M9: the Frame Sync Apply button must hide after its successful per-card apply');
  }
  if ((await js(`window.arcPower.graphicsGet(0)`)).values.flipMode !== 'vsync-off') {
    fail(`M9: the per-card apply did not reach the mock driver (flip='${(await js(`window.arcPower.graphicsGet(0)`)).values.flipMode}')`);
  }
  await js(`(() => {
    const s = document.querySelector('.graphics-select[data-graphics-select="flipMode"]');
    s.value = 'smooth-sync';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  if (!(await waitFor(win, `(() => { const b = document.querySelector('${cardSel('flipMode')} .oc-chip-apply'); return !!b && !b.hidden; })()`, 5000))) {
    fail('M9: the Frame Sync Apply button must return after a further change');
  }
  await clearToasts();
  await js(`document.querySelector('${cardSel('flipMode')} .oc-chip-apply').click()`);
  if (!(await waitFor(win, `(() => { const c = document.querySelector('${cardSel('flipMode')} .oc-chip-status'); return !!c && !c.hidden && (c.textContent ?? '').trim() === 'Applied'; })()`, 8000))) {
    fail('M9: the second per-card apply did not restore the Frame Sync Applied chip');
  }
  if (!(await waitFor(win, `document.querySelector('.floating-apply').hidden`, 5000))) {
    fail('M9: the floating Apply must hide after the per-card apply cleaned the last dirty control');
  }
  step('m9-per-card-apply', 'M9: per-card Apply - a change reveals the card button; its click round-tripped vsync-off through the mock (chip Applied, button hidden, driver flip=vsync-off); a further change brought the button back; clicking it again cleaned the page (floating Apply hidden)');

  // --- 5. the FPS apply + the Reset-to-default lifecycle ---------------------
  await js(`(() => {
    const s = document.querySelector('${fpsSlider}');
    s.value = '144';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await js(`document.querySelector('.floating-apply').click()`);
  if (!(await waitFor(win, `(() => { const c = document.querySelector('${cardSel('frameLimit')} .oc-chip-status'); return !!c && !c.hidden && (c.textContent ?? '').trim() === 'Applied'; })()`, 8000))) {
    fail(`M8: the FPS apply did not flip its chip to 'Applied' (driver frameLimit='${JSON.stringify((await js(`window.arcPower.graphicsGet(0)`)).values.frameLimit)}')`);
  }
  if ((await js(`window.arcPower.graphicsGet(0)`)).values.frameLimit.value !== 144) {
    fail(`M8: the FPS round trip failed (driver frameLimit='${JSON.stringify((await js(`window.arcPower.graphicsGet(0)`)).values.frameLimit)}')`);
  }
  // M9 (the FG Reset lifecycle - the block name): change -> dirty; reset ->
  // back to the driver default -> CLEAN (the Apply hides); change + apply ->
  // 'Applied' chip; reset AFTER an apply -> the DIRTY state - the card shows
  // the .oc-chip-apply BUTTON (the M9 chip machine; the old warn 'Unapplied'
  // chip is GONE) + the floating Apply; apply -> 'Applied' again + the
  // driver returns to the fixture default.
  const fgReset = `(() => {
    const btns = Array.from(document.querySelectorAll('${cardSel('frameGenOverride')} .btn'));
    const reset = btns.find((b) => (b.textContent ?? '').includes('Reset'));
    reset.click();
  })()`;
  const fgSelect = `document.querySelector('.graphics-select[data-graphics-select="frameGenOverride"]')`;
  await js(`(() => { const s = ${fgSelect}; s.value = '3x'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  if (!(await waitFor(win, `!!document.querySelector('.floating-apply') && !document.querySelector('.floating-apply').hidden`, 5000))) {
    fail('M8: changing the FG dropdown did not dirty the draft');
  }
  await js(fgReset);
  if (!(await waitFor(win, `document.querySelector('.floating-apply').hidden`, 5000))) {
    fail('M8: Reset to default on the FG card must restore the driver-default state (the Apply hides)');
  }
  await js(`(() => { const s = ${fgSelect}; s.value = '3x'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await clearToasts();
  await js(`document.querySelector('.floating-apply').click()`);
  if (!(await waitFor(win, `(() => { const c = document.querySelector('${cardSel('frameGenOverride')} .oc-chip-status'); return !!c && !c.hidden && (c.textContent ?? '').trim() === 'Applied' && c.className.includes('chip-ok'); })()`, 8000))) {
    fail(`M8: the FG apply did not flip its chip to 'Applied' (driver fg='${(await js(`window.arcPower.graphicsGet(0)`)).values.frameGenOverride}')`);
  }
  await js(fgReset);
  if (!(await waitFor(win, `(() => {
    const c = document.querySelector('${cardSel('frameGenOverride')} .oc-chip-status');
    const b = document.querySelector('${cardSel('frameGenOverride')} .oc-chip-apply');
    return !!c && c.hidden && !!b && !b.hidden;
  })()`, 5000))) {
    fail('M9: Reset after an apply must flip the FG card to the dirty state (the .oc-chip-apply button shows, the chip hides)');
  }
  if (await js(`document.body.textContent.includes('Unapplied')`)) fail('M9: the "Unapplied" chip text must not exist anywhere in the DOM');
  await clearToasts();
  await js(`document.querySelector('.floating-apply').click()`);
  if (!(await waitFor(win, `(() => { const c = document.querySelector('${cardSel('frameGenOverride')} .oc-chip-status'); return !!c && !c.hidden && (c.textContent ?? '').trim() === 'Applied'; })()`, 8000))) {
    fail('M8: the FG reset apply did not flip its chip back to Applied');
  }
  if ((await js(`window.arcPower.graphicsGet(0)`)).values.frameGenOverride !== 'app-choice') {
    fail(`M8: the FG reset apply did not return the driver to the fixture default (fg='${(await js(`window.arcPower.graphicsGet(0)`)).values.frameGenOverride}')`);
  }
  step('m9-fps-reset', 'M9: FPS slider apply round trip (144 FPS); the FG Reset lifecycle: change -> dirty, reset -> clean, apply -> "Applied" chip, reset after apply -> the .oc-chip-apply button (the dirty state - the old "Unapplied" chip is GONE), apply -> driver back to the fixture default');

  // --- 5b. M9: the On + Boost round trip ------------------------------------
  // The Low Latency dropdown carries the FULL off/on/on-boost list on every
  // driver (the M9 optionsOf change; the card gate stays). The mock accepts
  // the value - select -> per-card apply -> the 'Applied' chip + the driver
  // reads 'on-boost'; restore the fixture default (the deterministic
  // session end).
  await js(`(() => {
    const s = document.querySelector('.graphics-select[data-graphics-select="lowLatency"]');
    s.value = 'on-boost';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  if (!(await waitFor(win, `(() => { const b = document.querySelector('${cardSel('lowLatency')} .oc-chip-apply'); return !!b && !b.hidden; })()`, 5000))) {
    fail('M9: selecting On + Boost must reveal the Low Latency card Apply button');
  }
  await clearToasts();
  await js(`document.querySelector('${cardSel('lowLatency')} .oc-chip-apply').click()`);
  if (!(await waitFor(win, `(() => { const c = document.querySelector('${cardSel('lowLatency')} .oc-chip-status'); return !!c && !c.hidden && (c.textContent ?? '').trim() === 'Applied' && c.className.includes('chip-ok'); })()`, 8000))) {
    fail(`M9: the On + Boost apply did not flip the Low Latency chip to 'Applied' (driver ll='${(await js(`window.arcPower.graphicsGet(0)`)).values.lowLatency}')`);
  }
  if ((await js(`window.arcPower.graphicsGet(0)`)).values.lowLatency !== 'on-boost') {
    fail(`M9: the On + Boost round trip failed (driver lowLatency='${(await js(`window.arcPower.graphicsGet(0)`)).values.lowLatency}')`);
  }
  await js(`(() => {
    const s = document.querySelector('.graphics-select[data-graphics-select="lowLatency"]');
    s.value = 'off';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await clearToasts();
  await js(`document.querySelector('${cardSel('lowLatency')} .oc-chip-apply').click()`);
  if (!(await waitFor(win, `(() => { const c = document.querySelector('${cardSel('lowLatency')} .oc-chip-status'); return !!c && !c.hidden && (c.textContent ?? '').trim() === 'Applied'; })()`, 8000))) {
    fail('M9: the Low Latency restore apply did not flip the chip back to Applied');
  }
  if ((await js(`window.arcPower.graphicsGet(0)`)).values.lowLatency !== 'off') {
    fail(`M9: the Low Latency restore did not reach the driver (lowLatency='${(await js(`window.arcPower.graphicsGet(0)`)).values.lowLatency}')`);
  }
  step('m9-on-boost', 'M9: the On + Boost round trip - the Low Latency dropdown offered on-boost (the full list on every driver), the per-card apply landed it in the mock driver (chip Applied), restored to off');

  // --- 5c. M17c: the FPS Reset-to-default mirrors the OFF state ------------
  // The reset flips the dropdown to Off, hides the WHOLE slider-row and
  // restores { enabled: false, value: 60 } - the apply payload shape is
  // byte-identical to the pre-M17c reset (the { enabled, value } contract).
  await js(`(() => {
    const card = document.querySelector('${cardSel('frameLimit')}');
    const btn = Array.from(card.querySelectorAll('.btn')).find((b) => (b.textContent ?? '').includes('Reset'));
    btn.click();
  })()`);
  if (!(await waitFor(win, `(() => {
    const s = document.querySelector('${fpsToggle}');
    const r = document.querySelector('${fpsSliderRow}');
    return !!s && s.value === 'off' && !!r && r.hidden;
  })()`, 5000))) {
    fail('M17c: the FPS Reset-to-default must flip the dropdown to Off AND hide the whole slider-row');
  }
  // The reset draft is dirty vs the applied 144 FPS -> the floating Apply
  // appears; its payload is the byte-identical { enabled, value } shape.
  await clearToasts();
  if (!(await waitFor(win, `!!document.querySelector('.floating-apply') && !document.querySelector('.floating-apply').hidden`, 5000))) {
    fail('M17c: the FPS reset draft must be dirty (the floating Apply appears)');
  }
  await js(`document.querySelector('.floating-apply')?.click()`);
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) {
    fail('M17c: the FPS reset apply did not land');
  }
  const resetDriver = await js(`window.arcPower.graphicsGet(0)`);
  if (!resetDriver.values.frameLimit || resetDriver.values.frameLimit.enabled !== false) {
    fail(`M17c: the FPS reset apply must write { enabled:false } (got ${JSON.stringify(resetDriver.values.frameLimit)})`);
  }
  if (resetDriver.values.frameLimit.value !== 60) {
    fail(`M17c: the FPS reset must restore the fixture default value 60 (got ${JSON.stringify(resetDriver.values.frameLimit)})`);
  }
  step('m17c-fps-reset', 'M17c: FPS Reset-to-default mirrors the Off state - dropdown Off, slider-row hidden, the apply writes { enabled:false, value:60 } (the shape is byte-identical)');

  // --- 6. the multi-device degrade (RID_MOCK_MULTI_DEVICE=1) -----------------
  if (process.env.RID_MOCK_MULTI_DEVICE === '1') {
    const IGPU_NAME = 'Mock Arc iGPU (fixture)';
    const A770_NAME = 'Mock Arc A770 Graphics (fixture) 16GB GDDR6';
    const driveSelector = (value) => js(`(() => {
      const s = document.querySelector('.card-grid .device-select');
      if (!s) return 'no-select';
      s.value = '${value}';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`);
    // The graphics page leaves the device switch to the shared selector -
    // switch to the iGPU via the DASHBOARD selector, then visit #/graphics.
    await js(`location.hash = '#/dashboard'`);
    await sleep(200);
    if ((await driveSelector('1')) !== 'ok') fail('M8: the dashboard selector change did not dispatch (multi-device)');
    if (!(await waitFor(win, `(document.querySelector('.gpu-name')?.textContent ?? '').trim() === '${IGPU_NAME}'`, 8000))) {
      fail('M8: the switch to device 1 did not land');
    }
    await js(`location.hash = '#/graphics'`);
    await sleep(250);
    if (!(await waitFor(win, `document.querySelectorAll('.graphics-card').length === 4 && Array.from(document.querySelectorAll('.graphics-card')).every((c) => (c.textContent ?? '').includes('Not supported on this GPU.'))`, 8000))) {
      fail(`M8: the iGPU must show the supported-all-false state on all four cards (a device switch must never crash - page='${(await js(`(document.getElementById('page')?.textContent ?? '').slice(0, 200)`)).slice(0, 200)}')`);
    }
    // Switch back to the A770 -> the fixture returns.
    await js(`location.hash = '#/dashboard'`);
    await sleep(200);
    if ((await driveSelector('0')) !== 'ok') fail('M8: the switch back to device 0 did not dispatch');
    if (!(await waitFor(win, `(document.querySelector('.gpu-name')?.textContent ?? '').trim() === '${A770_NAME}'`, 8000))) {
      fail('M8: the switch back to device 0 did not land');
    }
    await js(`location.hash = '#/graphics'`);
    await sleep(250);
    if (!(await waitFor(win, `document.querySelectorAll('.graphics-card').length === 4 && !document.querySelectorAll('.graphics-card')[0].textContent.includes('Not supported')`, 8000))) {
      fail('M8: the A770 graphics surface must return after switching back (the fixture)');
    }
    step('m8-multi-device', 'M8 (RID_MOCK_MULTI_DEVICE=1): the iGPU serves the supported-all-false state (no crash); switching back to the A770 restores the fixture');
  }
}

// ---------------------------------------------------------------------------
// M2D - featureset variants (RID_MOCK_FEATURESET=b580|pro-b50|arc-igpu)
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
  // M17d (Run C, item 0c): the stock-mode flag - the a750/acer STOCK-mode
  // pins (the stock slider + the >max refusal) run under the
  // RID_MOCK_STOCK_MODE=1 combos of this function (the main flow's
  // stockMode const is scoped to the OTHER verify function).
  const stockMode = process.env.RID_MOCK_STOCK_MODE === '1';
  // M4-D2 (§7/§8): the old Overclocking + Fan pages are the Tuning page -
  // same gotoView pattern as the default flow.
  const gotoView = async (viewLabel) => {
    await js(`(() => {
      const b = Array.from(document.querySelectorAll('.tuning-view-btn')).find((x) => x.textContent.trim() === '${viewLabel}');
      if (b && !b.classList.contains('active')) { b.click(); return true; }
      return false;
    })()`);
    await sleep(250);
  };
  const gotoOverclocking = async () => {
    await js(`location.hash = '#/tuning'`);
    await sleep(250);
    await gotoView('Tuning');
  };

  // --- boot: shell + dropdown -----------------------------------------------
  // M4-D2 (§7): 6 nav links (Overclocking + Fan merged into Tuning). M6: 7
  // nav links (the Overlay Settings page joined the sidebar). M8: 8 (the
  // Graphics tab joined below Tuning). M9: 7 again (the Overlay tab moved
  // into the Monitoring page's Overlay view).
  if (!(await waitFor(win, `document.querySelectorAll('.sidebar-link').length === 7`))) {
    fail('sidebar did not render (7 nav links expected - the Graphics tab joined in M8, the Overlay tab moved into Monitoring in M9)');
  }
  // M3-A (shared shell): the brand is text + blue bar (no logo image), and
  // the IGS indicator is gone everywhere.
  if (await js(`!!document.querySelector('.sidebar-brand img.sidebar-logo')`)) fail('M3-A: sidebar logo image still rendered');
  if (await js(`document.body.textContent.includes('Service Status')`)) fail('M3-A: "Service Status" still rendered');
  if (await js(`document.body.textContent.includes('IGS')`)) fail('M3-A: IGS still surfaced as a status item');
  if (!(await waitFor(win, `!!document.querySelector('.badge-mock')`))) fail('mock badge missing');
  if (!(await waitFor(win, `!!document.querySelector('.featureset-select')`))) fail('featureset dropdown missing in mock mode');
  const options = await js(`Array.from(document.querySelectorAll('.featureset-select option')).map((o) => o.value)`);
  // M17c/M17d: the a750 + the Acer AIB variant joined the distribution
  // (6 files).
  if (options.length !== 6) fail(`dropdown lists ${options.length} featuresets (expected 6)`);
  const selected = await js(`document.querySelector('.featureset-select').value`);
  if (selected !== fsId) fail(`current selection is '${selected}' (expected '${fsId}')`);
  step('boot', `shell + dropdown rendered: ${options.join(', ')} (current '${selected}')`);

  // M4-A/M4-B: the shared waiver boot-step - the boot prompt appears in
  // EVERY session; Cancel it BEFORE the per-featureset assertions (F4: the
  // b580 apply-dialog section below must see a clean page, not the boot
  // modal). M17 (B50-class): OC-locked devices (pro-b50 / arc-igpu - no OC
  // controls, no waiver) must NOT prompt at boot - the driver refuses
  // ctlOverclockWaiverSet with UNSUPPORTED_FEATURE, a prompt the user could
  // never satisfy.
  let bootAccepted = false;
  if (noOc) {
    if (!(await waitFor(win, `document.querySelectorAll('.health-card').length === 1`, 15000))) {
      fail(`M17: the no-OC boot did not land the dashboard health card: page='${(await js(`(document.getElementById('page')?.textContent ?? '').slice(0, 200)`))}'`);
    }
    await sleep(600);
    if (await js(`!!document.querySelector('.modal')`)) {
      fail(`M17: the boot waiver prompt appeared on an OC-locked device ('${fsId}') - no OC, no waiver`);
    }
    step('waiver-boot', `no-OC boot waiver prompt ABSENT (OC-locked device - no waiver to accept)`);
  } else {
    bootAccepted = await bootWaiverStep(win, js, waitFor);
    step('waiver-boot', `boot waiver prompt handled (${process.env.RID_MOCK_WAIVER_PERSISTED === '1' ? 'persisted acceptance: boot prompt SKIPPED entirely (M4-D permanent acceptance)' : 'cancelled'})`);
  }

  // --- boot: wait for caps + state in the store -----------------------------
  // The renderer boot (health -> devices -> probes -> caps -> telemetry)
  // finishes AFTER the shell renders; the dashboard full-renders when caps
  // arrive (its render signature includes caps) - the device-card 'Compute'
  // row is the signal. Navigating to a caps-driven page before this leaves
  // it stuck on 'Loading device capabilities…' (no page onUpdate).
  await js(`location.hash = '#/dashboard'`);
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('.card-grid .kv')).some((k) => (k.getAttribute('data-label') ?? '') === 'Compute')`, 10000))) {
    fail(`boot did not deliver caps: page='${await js(`(document.getElementById('page')?.textContent ?? '').slice(0, 200)`)}'`);
  }
  step('boot-caps', `boot delivered caps (device card 'Compute' row)`);

  // M4-A review F2: the featureset variants must not drift from the shared
  // waiver display - the dashboard GPU Status card + waiver row are pinned
  // here like the default flow (5 rows, live per-caps waiver detail; M16:
  // the device row renders ABOVE the driver row + the OC row reads the
  // stock-state text).
  if (!(await waitFor(win, `document.querySelectorAll('.health-card').length === 1`))) {
    fail('expected exactly one GPU Status card');
  }
  if (await js(`document.querySelectorAll('.health-card .health-row').length !== 5`)) {
    fail(`health card rows: got ${await js(`document.querySelectorAll('.health-card .health-row').length`)} (expected 5)`);
  }
  const rowIds = await js(`Array.from(document.querySelectorAll('.health-card .health-row')).map((r) => r.dataset.row).join(',')`);
  if (rowIds !== 'device,driver,oc,waiver,app') fail(`health card rows are '${rowIds}' (expected device,driver,oc,waiver,app - the M16 flip)`);
  const rowLabels = await js(`Array.from(document.querySelectorAll('.health-card .health-row-label')).map((l) => l.textContent).join('|')`);
  for (const want of ['Device detected', 'Driver installed', 'OC status', 'OC waiver', 'Arc Power working']) {
    if (!rowLabels.includes(want)) fail(`health card missing row '${want}' (got '${rowLabels}')`);
  }
  const waiverDetailExpr = `document.querySelector('.health-card .health-row[data-row="waiver"] .health-row-detail')?.textContent ?? ''`;
  // M17 (B50-class): OC-locked devices read the neutral no-waiver text
  // (ok dot, never clickable) - the old 'Not Accepted' error row was an
  // un-answerable dead end there.
  const waiverExpected = noOc ? 'Not supported on this GPU' : (bootAccepted ? 'Accepted' : 'Not Accepted');
  if (!(await waitFor(win, `(${waiverDetailExpr}).trim() === '${waiverExpected}'`, 5000))) {
    fail(`M4-A: the health-card waiver row reads '${await js(waiverDetailExpr)}' (expected '${waiverExpected}')`);
  }
  const waiverDot = await js(`document.querySelector('.health-card .health-row[data-row="waiver"] .status-dot')?.className ?? ''`);
  if (!(noOc || bootAccepted ? /status-ok/ : /status-error/).test(waiverDot)) {
    fail(`M4-A: the waiver row dot is '${waiverDot}' (expected ${noOc || bootAccepted ? 'ok (green)' : 'error (red)'})`);
  }
  const waiverClickable = await js(`document.querySelector('.health-card .health-row[data-row="waiver"]')?.classList.contains('health-row-clickable')`);
  if (waiverClickable === (noOc || bootAccepted)) fail(`M4-A: waiver row clickability is '${waiverClickable}' (expected ${noOc || bootAccepted ? 'not clickable' : 'clickable'} - clickable only while unaccepted on an OC-capable device)`);
  step('health-card', `GPU Status card: 5 rows '${rowLabels}'; waiver row 'OC waiver - ${waiverExpected}' (${noOc || bootAccepted ? 'green, no click action' : 'red, clickable'})`);

  // M17c/M17d: the Board partner row per featureset (the dashboard device
  // card). a750 -> 'ASRock' (subsys vendor 0x1849 + the FIXTURE-ONLY
  // variant id 0x0A75 - step-4 N7: the a750 mock never reuses the A770's
  // observed 0x6001, so the model decodes null and the row is vendor-only);
  // acer-a750 -> 'Acer (Predator BiFrost)' (subsys vendor 0x1025 + the
  // LIVE-PINNED 0xB102 variant - the 2026-08-12 probe, pciSubsysId 45314 -
  // the model decodes and the row renders vendor + model);
  // b580 -> 'Intel (Limited Edition)' (subsys 0x8086, no variant - vendor
  // only); arc-igpu -> the honest grey '-' (no subsystem fields - the
  // unknown fallback pin); pro-b50 -> '-' (no subsystem fields either).
  const aibExpected = fsId === 'a750' ? 'ASRock'
    : fsId === 'acer-a750' ? 'Acer (Predator BiFrost)'
    : fsId === 'b580' ? 'Intel (Limited Edition)'
    : '-';
  if (!(await waitFor(win, `(() => {
    const row = Array.from(document.querySelectorAll('.card-grid .device-card .kv'))
      .find((k) => (k.getAttribute('data-label') ?? '') === 'Board partner');
    return row && (row.textContent ?? '').trim() === '${aibExpected}';
  })()`, 5000))) {
    fail(`M17c ('${fsId}'): the Board partner row is '${await js(`document.querySelector('.card-grid .device-card .kv[data-label="Board partner"]')?.textContent ?? ''`)}' (expected '${aibExpected}')`);
  }
  if (aibExpected === '-' && !(await js(`document.querySelector('.card-grid .device-card .kv[data-label="Board partner"] span')?.classList.contains('text-unknown')`))) {
    fail(`M17c ('${fsId}'): the unknown Board partner '-' must render the honest grey (text-unknown)`);
  }
  step('board-partner', `M17c ('${fsId}'): Board partner row '${aibExpected}' (${aibExpected === '-' ? 'the honest grey unknown fallback' : 'the caps AIB decode'})`);

  // --- tuning surface per featureset (M4-D2: #/overclocking -> #/tuning) ---
  await gotoOverclocking();

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
    // M17f (the round-5 fold): no lock editor -> no lock RANGE line either
    // (the honest absence on the no-lock sessions - arc-igpu/pro-b50).
    if (await js(`!!document.querySelector('.gpu-lock-range')`)) {
      fail(`M17f ('${fsId}'): the lock range line is rendered on a session without gpuLock support (no lock editor -> no range line)`);
    }
    step('oc-none', `'${fsId}': 0 OC cards, no-OC note, no floating Apply, no lock range line`);
  } else {
    // M17d (Run D)/M17e (Run B - N2): the OC-CARD count - the selector is
    // '.oc-card' ONLY (the ', .gpu-lock-editor' term is DROPPED: the editor
    // is NESTED inside the freq card now, so the union selector would
    // still match it and the count stays 4+1=5 - the pin asserts the 4
    // slider cards exactly; the nested editor is covered by the
    // .gpu-lock-editor presence pins). b580 stays 4 (percent units, no
    // gpuLock control -> no toggle/editor). arc-igpu / pro-b50 are the
    // no-OC branch above (0 cards).
    const lockCard = (await js(`window.arcPower.getCapabilities(0)`)).controls?.gpuLock === true;
    if (lockCard) {
      if (!(await waitFor(win, `!!document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .gpu-lock-editor')`, 8000))) {
        fail(`M17e: the gpuLock editor is not nested inside the freq card on '${fsId}' (gpuLock-capable)`);
      }
    }
    const expectedCards = 4;
    if (!(await waitFor(win, `document.querySelectorAll('.oc-card').length === ${expectedCards}`, 8000))) {
      fail(`expected ${expectedCards} OC cards on '${fsId}' (the slider cards - the lock editor is nested inside the freq card, never counted separately), got ${await js(`document.querySelectorAll('.oc-card').length`)}; page='${await js(`(document.getElementById('page')?.textContent ?? '').slice(0, 300)`)}'`);
    }
    const plRange = await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-meta .oc-range')?.textContent ?? ''`);
    const plValue = await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value')?.textContent ?? ''`);
    if (fsId === 'b580') {
      if (!plRange.includes('%')) fail(`b580 PL range does not show % units: '${plRange}'`);
      if (plValue.trim() !== '100 %') fail(`b580 PL readout is '${plValue}' (expected '100 %')`);
      // M17f: the sysman PL2 read-out on a PERCENT-UNIT device - the honest
      // '-' (the real sysman layer reads watts regardless of the IGCL
      // units, and the percent fixture value must never masquerade as W).
      if (!(await waitFor(win, `(document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? '').trim() === 'PL1 - / PL2 -'`, 5000))) {
        fail(`M17f: the b580 PL2 read-out is '${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? ''`)}' (expected the honest 'PL1 - / PL2 -' on a percent-unit device)`);
      }
      step('m17f-pl2-b580', `M17f: the b580 (percent-unit) power-limit card shows the honest 'PL1 - / PL2 -' sysman read-out (the percent fixture never masquerades as W)`);
      const plMax = await js(`document.querySelector('.oc-card[data-control="powerLimitW"] input[type="range"]')?.getAttribute('max')`);
      if (plMax !== '150') fail(`b580 PL slider max is '${plMax}' (expected 150)`);
      // M4-B: the b580 freq range mirrors into the negative half-plane too
      // (-500..500) and the percent units still render with the mirror.
      await sleep(150);
      const b580FreqMin = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] input[type="range"]')?.getAttribute('min')`);
      const b580FreqMax = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] input[type="range"]')?.getAttribute('max')`);
      if (b580FreqMin !== '-500' || b580FreqMax !== '500') fail(`M4-B: b580 freq slider range is '${b580FreqMin}'..'${b580FreqMax}' (expected -500..500)`);
      const b580VoltRange = await js(`document.querySelector('.oc-card[data-control="gpuVoltOffsetV"] .oc-meta .oc-range')?.textContent ?? ''`);
      if (!b580VoltRange.includes('-100') || !b580VoltRange.includes('100')) fail(`M4-B: b580 volt range does not mirror into the negative half: '${b580VoltRange}'`);
      // M3-C-G: the per-card Stock/Medium/Max preset chips are REMOVED.
      const presetCount = await js(`document.querySelectorAll('.oc-card .oc-presets').length`);
      if (presetCount !== 0) fail(`M3-C-G: preset chips still render (${presetCount})`);
      const adv = await js(`document.querySelector('.advanced-card')?.textContent ?? ''`);
      // M4J (D): the Advanced section on b580 = the VRAM clock editor ONLY.
      // The M4-B expert rows (vfCurve/VRAM-offset M5 notes) and the gpuLock
      // editor are REMOVED; the VRAM editor's slider covers the range
      // (0..3 Gbps, step 0.1) with the real apply + read-back.
      if (!adv.includes('VRAM clock')) fail(`M4J (D): b580 advanced is missing the VRAM clock editor: '${adv}'`);
      if (await js(`document.querySelectorAll('.expert-row').length !== 0`)) {
        fail('M4J (D): the expert rows are still rendered on b580 (removed - the section holds the VRAM editor only)');
      }
      if (adv.includes('Unsupported on this GPU')) fail('M4-D: b580 advanced still renders "Unsupported on this GPU" rows (removed entirely)');
      if (await js(`!!document.querySelector('.gpu-lock-editor')`)) {
        fail('M17e: the gpuLock editor is rendered on b580 (no gpuLock control - the freq card has no toggle/editor)');
      }
      if (await js(`!!document.querySelector('.gpu-lock-range')`)) {
        fail('M17f: the lock range line is rendered on b580 (no gpuLock control -> no lock editor -> no range line)');
      }
      if (await js(`!!document.querySelector('.vram-editor-card')`) === false) {
        fail('M4J (D): the VRAM clock editor card is missing on b580');
      }
      const vramMin = await js(`document.querySelector('.vram-editor-card input[type="range"]')?.getAttribute('min')`);
      const vramMax = await js(`document.querySelector('.vram-editor-card input[type="range"]')?.getAttribute('max')`);
      const vramStep = await js(`document.querySelector('.vram-editor-card input[type="range"]')?.getAttribute('step')`);
      if (vramMin !== '0' || vramMax !== '3' || vramStep !== '0.1') {
        fail(`M4J (D): the VRAM slider range is ${vramMin}..${vramMax} step ${vramStep} (expected 0..3 step 0.1 - the fixture vramFreqOffsetGts)`);
      }
      const vramMeta = await js(`document.querySelector('.vram-editor-card .oc-meta .oc-range')?.textContent ?? ''`);
      if (!vramMeta.includes('Gbps')) fail(`M4J (D): the VRAM editor meta line does not show the Gbps units: '${vramMeta}'`);
      step('oc-b580', `b580: 4 cards, PL '${plRange}', readout '${plValue}', freq ${b580FreqMin}..${b580FreqMax} MHz, volt '${b580VoltRange}', no preset chips (M3-C-G), Advanced = VRAM clock editor (0..3 Gbps step 0.1)`);
    } else if (fsId === 'a750' || fsId === 'acer-a750') {
      // M17c/M17d (round-1 N2 + round-1 S1): the a750 slider maxes are
      // AUTOMATED here (the user-hardware-only pin becomes a mock variant;
      // the acer-a750 variant runs the same checks - identical ranges, the
      // Acer AIB decode):
      // the volt slider max is the driver props - 0.285 on the a750 / 0.288
      // on the acer-a750 (the 2026-08-12 probe: the Acer card's props max
      // 0.288 V - NOT clamped to 0.234, the global clamp is gone) - and the
      // PL slider max is 270 in the mock's ADVANCED default mode (M17d
      // FLIP: the a750 ADVANCED ceiling is the probe-verified 270 W KMD
      // ceiling; the stock 216 is the STOCK-mode slider). M17d (Run C,
      // item 0c): the RID_MOCK_STOCK_MODE=1 combos pin the STOCK slider
      // instead - a750 AND acer-a750 216 W (the probe-pinned Acer stock:
      // the 2026-08-12 verdict, the 235 BiFrost documented row refuted as
      // a stock value on the Acer card) - and the advanced apply/refusal
      // pins are guarded off (a stock-mode 250 W apply REFUSES, covered by
      // the stock-refusal pin in the stock variant section above). M17d
      // (2026-08-12): the ADVANCED TL slider max is the probe-verified 115
      // (the mock's extended.tlMax rides both a750 fixtures). The table's
      // cap arithmetic is covered by the pure table unit tests, NOT by this
      // variant (the fixture already encodes the final ranges - the
      // reviewer note).
      const a750VoltMax = await js(`document.querySelector('.oc-card[data-control="gpuVoltOffsetV"] input[type="range"]')?.getAttribute('max')`);
      const a750VoltExpected = fsId === 'acer-a750' ? '0.288' : '0.285';
      if (a750VoltMax !== a750VoltExpected) fail(`M17c: the ${fsId} volt slider max is '${a750VoltMax}' (expected ${a750VoltExpected} - the driver props pass through${fsId === 'acer-a750' ? '; the 2026-08-12 probe: the Acer card props max 0.288 V' : ''}, NOT clamped to 0.234)`);
      const a750VoltStep = await js(`document.querySelector('.oc-card[data-control="gpuVoltOffsetV"] input[type="range"]')?.getAttribute('step')`);
      if (a750VoltStep !== '0.001') fail(`M17c: the a750 volt slider step is '${a750VoltStep}' (expected 0.001)`);
      const a750PlMax = await js(`document.querySelector('.oc-card[data-control="powerLimitW"] input[type="range"]')?.getAttribute('max')`);
      const a750StockPl = '216'; // the a750 AND the acer-a750 stock ceiling - the ASRock 216 + the probe-pinned Acer 216 (the 2026-08-12 verdict)
      if (stockMode) {
        if (a750PlMax !== a750StockPl) fail(`M17d (0c): the ${fsId} STOCK-mode PL slider max is '${a750PlMax}' (expected 216 - ${fsId === 'acer-a750' ? 'the probe-pinned Acer stock ceiling (the 2026-08-12 verdict: the DriverStore props max 216, the 235 BiFrost documented row refuted)' : 'the a750 216 W ASRock stock ceiling'})`);
      } else {
        if (a750PlMax !== '270') fail(`M17d: the a750 PL slider max is '${a750PlMax}' (expected 270 - the probe-verified KMD ceiling, the ADVANCED default mode)`);
      }
      const a750PlValue = await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value')?.textContent ?? ''`);
      if (a750PlValue.trim() !== '190 W') fail(`M17c: the a750 PL readout is '${a750PlValue}' (expected '190 W' - the stock default)`);
      // M17f: the sysman PL2 read-out on the a750/acer-a750 - the fixture
      // mirror answers the stock default 190 W for both domains at boot.
      if (!(await waitFor(win, `(document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? '').trim() === 'PL1 190 W / PL2 190 W'`, 5000))) {
        fail(`M17f: the ${fsId} PL2 read-out is '${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? ''`)}' (expected 'PL1 190 W / PL2 190 W' - the fixture mirror at boot)`);
      }
      step('m17f-pl2-a750-boot', `M17f: the ${fsId} power-limit card shows the sysman read-out '${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? ''`)}' at boot`);
      // M17d (Run D)/M17e (Run B): the gpuLock editor renders NESTED inside
      // the freq card on the gpuLock-capable a750/acer-a750 fixtures (the
      // M17d standalone card is folded in; the mock starts unlocked).
      if (await js(`!!document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .gpu-lock-editor')`) === false) {
        fail(`M17d/M17e: the ${fsId} lock editor is missing (caps.controls.gpuLock is true there)`);
      }
      const lockLine = await js(`document.querySelector('.gpu-lock-current')?.textContent ?? ''`);
      if (!lockLine.includes('Dynamic (unlocked)')) {
        fail(`M17d/M17e: the ${fsId} lock read-out is '${lockLine}' (expected 'Lock: Dynamic (unlocked)' - the mock starts unlocked)`);
      }
      if (!stockMode) {
        // M17d (2026-08-12 probe verdict): the ADVANCED TL slider max is
        // the probe-verified 115 C (the mock's extended.tlMax rides both
        // a750 fixtures - the M17c "A750 advanced TL 90" pin INVERTS; the
        // 2026-08-12 app-path probe applied 100 AND 115 C).
        const a750TlMax = await js(`document.querySelector('.oc-card[data-control="tempLimitC"] input[type="range"]')?.getAttribute('max')`);
        if (a750TlMax !== '115') fail(`M17d: the ${fsId} ADVANCED TL slider max is '${a750TlMax}' (expected 115 - the probe-verified A750 advanced TL, 100 AND 115 C applied via the app path)`);
        // M17d FLIP (round-3 N3): the a750 listed-card ADVANCED gate - a
        // 250 W apply SUCCEEDS in advanced mode (the 270 KMD ceiling - the
        // M17c "refuses with the ceiling class" pin INVERTS); a value ABOVE
        // the 270 ceiling (271) must REFUSE with the ceiling class (never a
        // silent clamp) - the device-scoped ocModeRefusal pin.
        const applied = await js(`window.arcPower.applySettings(0, { powerLimitW: 250 })`);
        if (applied.result.ok !== true || applied.ocModeRefused !== undefined) {
          fail(`M17d: the a750 listed-card PL 250 apply must SUCCEED in advanced mode (got ${JSON.stringify(applied.result)})`);
        }
        const a750State = await js(`window.arcPower.getCurrentSettings(0)`);
        if (Math.abs(a750State.powerLimitW - 250) > 1e-6) {
          fail(`M17d: the a750 250 W apply must land (got ${a750State.powerLimitW})`);
        }
        const refusal = await js(`window.arcPower.applySettings(0, { powerLimitW: 271 })`);
        if (refusal.result.ok !== false || refusal.ocModeRefused !== true) {
          fail(`M17d: the a750 listed-card PL 271 apply must REFUSE (ocModeRefused, got ${JSON.stringify(refusal.result)})`);
        }
        const per = refusal.result.perControl?.powerLimitW;
        if (!per || per.ok !== false || per.errorCode !== 'out-of-range') {
          fail(`M17d: the a750 refusal must be the ceiling class per-control 'out-of-range' (got ${JSON.stringify(per)})`);
        }
        const a750After = await js(`window.arcPower.getCurrentSettings(0)`);
        if (Math.abs(a750After.powerLimitW - 250) > 1e-6) {
          fail(`M17d: the a750 refusal must never clamp into the device state (got ${a750After.powerLimitW})`);
        }
        // Restore the stock baseline for the later steps.
        await js(`window.arcPower.applySettings(0, { powerLimitW: 190 })`);
        // M17f (step-4 N4): the PL2 read-out freshness = PER-APPLY on the
        // a750/acer-a750 fixtures too (the boot pin above is the one-shot;
        // the a770 default flow pins the same freshness) - a UI apply
        // re-fetches the sysman line after every apply.
        const a750SetSlider = (value) => js(`(() => {
          const card = document.querySelector('.oc-card[data-control="powerLimitW"]');
          const input = card.querySelector('input[type="range"]');
          input.value = '${value}';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return card.querySelector('.oc-value').textContent;
        })()`);
        const a750ClickApply = () => js(`(() => { const b = document.querySelector('.floating-apply'); if (b && !b.hidden) { b.click(); return true; } return false; })()`);
        await a750SetSlider(200);
        if (!(await a750ClickApply())) fail(`M17f (N4): the floating Apply did not appear for the ${fsId} PL2-freshness apply`);
        if (!(await waitFor(win, `(document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? '').trim() === 'PL1 200 W / PL2 200 W'`, 5000))) {
          fail(`M17f (N4): the ${fsId} PL2 read-out did not refresh after the UI apply: '${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? ''`)}' (expected 'PL1 200 W / PL2 200 W' - the per-apply freshness)`);
        }
        await a750SetSlider(190);
        if (!(await a750ClickApply())) fail(`M17f (N4): the floating Apply did not reappear for the ${fsId} baseline restore`);
        if (!(await waitFor(win, `(document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? '').trim() === 'PL1 190 W / PL2 190 W'`, 5000))) {
          fail(`M17f (N4): the ${fsId} PL2 read-out did not follow the baseline restore: '${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? ''`)}' (expected 'PL1 190 W / PL2 190 W')`);
        }
        step('m17f-pl2-a750-fresh', `M17f (N4): the ${fsId} PL2 read-out refreshed PER-APPLY - 'PL1 200 W / PL2 200 W' after the 200 W UI apply, back to 'PL1 190 W / PL2 190 W' on the restore`);
        step('oc-a750', `a750: volt slider max ${a750VoltMax} V (NOT clamped to 0.234), step ${a750VoltStep}, PL slider max ${a750PlMax} W (the 270 KMD ceiling), readout '${a750PlValue.trim()}', a 250 W apply SUCCEEDS in advanced mode (lands 250 W), a >270 W (271) apply REFUSES with the ceiling class (device untouched)`);
      } else {
        // M17d (Run C, item 0c + the 2026-08-12 probe verdicts): the
        // STOCK-mode UX pin - a value ONE W above the per-AIB stock ceiling
        // (217 - both the a750 AND the acer-a750 stock caps are the
        // probe-pinned 216) REFUSES with the MODE message (never clamps,
        // never the generic 'clamps' text - the round-2 S8 class); the
        // device state stays untouched. The per-control TOAST contract
        // (the message winning) is the applyFailureText-pinned preference -
        // see the item-0b note below.
        const a750RefusalW = 217;
        const a750Refusal = await js(`window.arcPower.applySettings(0, { powerLimitW: ${a750RefusalW} })`);
        if (a750Refusal.result.ok !== false || a750Refusal.ocModeRefused !== true) {
          fail(`M17d (0c): the ${fsId} stock-mode PL ${a750RefusalW} apply must REFUSE (ocModeRefused, got ${JSON.stringify(a750Refusal.result)})`);
        }
        const a750Per = a750Refusal.result.perControl?.powerLimitW;
        if (!a750Per || a750Per.ok !== false || a750Per.errorCode !== 'out-of-range') {
          fail(`M17d (0c): the ${fsId} refusal must be the ceiling class per-control 'out-of-range' (got ${JSON.stringify(a750Per)})`);
        }
        if (!/Advanced OC Mode/.test(a750Per.message ?? '')) {
          fail(`M17d (0c): the ${fsId} refusal message is '${a750Per?.message}' (expected the mode message - never the generic 'clamps' text)`);
        }
        const a750After2 = await js(`window.arcPower.getCurrentSettings(0)`);
        if (Math.abs(a750After2.powerLimitW - 190) > 1e-6) {
          fail(`M17d (0c): the ${fsId} stock refusal must never clamp into the device state (got ${a750After2.powerLimitW})`);
        }
        // M17f (step-4 N4): the STOCK-mode per-apply freshness - a 200 W
        // UI apply (within the 216 W stock ceiling) refreshes the sysman
        // PL2 line + the restore follows (the per-apply freshness is
        // pinned on the stock variant of these fixtures too).
        const a750StockSetSlider = (value) => js(`(() => {
          const card = document.querySelector('.oc-card[data-control="powerLimitW"]');
          const input = card.querySelector('input[type="range"]');
          input.value = '${value}';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return card.querySelector('.oc-value').textContent;
        })()`);
        const a750StockClickApply = () => js(`(() => { const b = document.querySelector('.floating-apply'); if (b && !b.hidden) { b.click(); return true; } return false; })()`);
        await a750StockSetSlider(200);
        if (!(await a750StockClickApply())) fail(`M17f (N4): the floating Apply did not appear for the ${fsId} stock-mode PL2-freshness apply`);
        if (!(await waitFor(win, `(document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? '').trim() === 'PL1 200 W / PL2 200 W'`, 5000))) {
          fail(`M17f (N4): the ${fsId} STOCK-mode PL2 read-out did not refresh after the UI apply: '${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? ''`)}' (expected 'PL1 200 W / PL2 200 W')`);
        }
        await a750StockSetSlider(190);
        if (!(await a750StockClickApply())) fail(`M17f (N4): the floating Apply did not reappear for the ${fsId} stock-mode baseline restore`);
        if (!(await waitFor(win, `(document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? '').trim() === 'PL1 190 W / PL2 190 W'`, 5000))) {
          fail(`M17f (N4): the ${fsId} STOCK-mode PL2 read-out did not follow the baseline restore: '${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-sysman-limits')?.textContent ?? ''`)}' (expected 'PL1 190 W / PL2 190 W')`);
        }
        step('m17f-pl2-a750-fresh-stock', `M17f (N4): the ${fsId} STOCK-mode PL2 read-out refreshed PER-APPLY - 'PL1 200 W / PL2 200 W' after the 200 W UI apply, back to 'PL1 190 W / PL2 190 W' on the restore`);
        // M17d (item 0b): the TOAST contract is pinned as follows - the OC
        // slider UI is bounded to the gate ceiling BY CONSTRUCTION, so a
        // gate refusal can never fire from the OC page (the toast path for
        // it exists: applyFailureText - the per-control message wins, unit-
        // pinned in pure-errors.test.ts); the MAPPED-text fallback for a
        // DRIVER-shaped out-of-range refusal is pinned end-to-end through
        // the real UI by the fan-fail-toast step ('outside the range' for a
        // message-less driver failure). The envelope above carries the gate
        // message itself.
        step('oc-a750-stock', `${fsId}: STOCK mode - volt slider max ${a750VoltMax} V (the unclamp rides both modes), PL slider max ${a750PlMax} W (${fsId === 'acer-a750' ? 'the probe-pinned Acer 216 W stock ceiling (the 2026-08-12 verdict)' : 'the 216 W ASRock ceiling'}), readout '${a750PlValue.trim()}', a >max (${a750RefusalW} W) apply REFUSES with the mode message (device untouched at 190 W) - the toast contract is applyFailureText-pinned`);
      }
    } else {
      step('oc-generic', `'${fsId}': ${expectedCards} OC cards render`);
    }
  }
  // M4-A review F2: the OC page renders NO waiver status (the row lives only
  // in the dashboard GPU Status card - the apply-time dialog gate below is
  // unaffected).
  if (await js(`(document.getElementById('page')?.textContent ?? '').includes('OC waiver')`)) {
    fail('M4-A: the OC page still renders the waiver status (dashboard health card only)');
  }
  step('waiver-absent-oc', 'OC page has no waiver status row (dashboard health card only)');

  // --- fan surface per featureset (M4-D2: the Tuning page's fan sub-view) ---
  await js(`location.hash = '#/fan'`);
  await sleep(250);
  const fanViewActive = await js(`(() => {
    const b = Array.from(document.querySelectorAll('.tuning-view-btn')).find((x) => x.textContent.trim() === 'Fan Curve');
    return !!b && b.classList.contains('active');
  })()`);
  if (!fanViewActive) fail('M4-D2: the #/fan redirect did not activate the Fan Curve sub-view');
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
    // M4-C: the Fixed tab ALWAYS renders in the editable editor - disabled
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
  // lives only in the dashboard GPU Status card).
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
  const fanTile = await js(`Array.from(document.querySelectorAll('#mon-readout-gpu .stat-tile')).find((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'Fan')?.querySelector('.stat-value')?.textContent ?? ''`);
  if (fsId === 'arc-igpu') {
    if (fanTile !== '-') fail(`iGPU fan tile should read '-' (no fan), got '${fanTile}'`);
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
  await gotoOverclocking();
  await swapTo('a770');
  if (!(await waitFor(win, `(document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value')?.textContent ?? '').trim() === '210 W'`))) {
    fail('swap to a770 did not re-render the OC page with W units');
  }
  const a770Caps = await js(`window.arcPower.getCapabilities(0)`);
  // M4J clarification (S1/F2 REVERTED): the swapped-in a770 surface reports
  // its FULL extended range in advanced mode (the a770 featureset carries
  // extendedRanges + the mock default mode is advanced) - the caps-level
  // vramFreqOffset gate is gone, as in 1.0.3.
  // M17d (Run C): the RID_MOCK_STOCK_MODE=1 combos report the a770 STOCK
  // shape instead (252 W - no extendedRanges in a stock session).
  const expectedSwapPlMax = stockMode ? 252 : 315;
  if (a770Caps.ranges.powerLimitW.units !== 'W' || a770Caps.ranges.powerLimitW.max !== expectedSwapPlMax) {
    fail(`swap to a770: caps wrong: ${JSON.stringify(a770Caps.ranges.powerLimitW)} (expected the a770 ${expectedSwapPlMax} W ${stockMode ? 'stock' : 'extended in advanced mode'} surface)`);
  }
  step('swap-a770', `swap -> a770: OC re-rendered '210 W', PL range max ${a770Caps.ranges.powerLimitW.max} W (the a770 ${stockMode ? 'stock' : 'extended'} surface)`);
  // M2D: the swap payload carries the featureset driver date - the HEALTH
  // card's driver row (the GPU card's Driver version row is REMOVED -
  // M4-H) must show its own registry date even when the boot featureset
  // had none.
  const healthDriverRow = () => js(`document.querySelector('.health-card .health-row[data-row="driver"] .health-row-detail')?.textContent ?? ''`);
  await js(`location.hash = '#/dashboard'`);
  await sleep(250);
  const a770Row = await healthDriverRow();
  if (!a770Row.includes('Jul 05, 2026')) fail(`swap to a770: driver date missing on the health row: '${a770Row}'`);
  await gotoOverclocking();
  await swapTo(fsId);
  // M17c: the a750 swap-back restores the W-unit surface (190 W readout).
  const backOk = fsId === 'b580'
    ? await waitFor(win, `(document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value')?.textContent ?? '').trim() === '100 %'`)
    : (fsId === 'a750' || fsId === 'acer-a750')
      ? await waitFor(win, `(document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value')?.textContent ?? '').trim() === '190 W'`)
      : await waitFor(win, `document.querySelectorAll('.oc-card').length === 0`);
  if (!backOk) fail(`swap back to '${fsId}' did not restore its surface`);
  if (fsId === 'b580') {
    // M2D: the unverified b580 swap must clear the a770 date, not pair it
    // with the b580 driver version.
    await js(`location.hash = '#/dashboard'`);
    await sleep(250);
    const backRow = await healthDriverRow();
    if (backRow.includes('Jul')) fail(`swap back to b580: stale driver date on the health row: '${backRow}'`);
    await gotoOverclocking();
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
    // green - assert the whole apply succeeded: no error toast + ALL four
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

    // --- M4J (D): the VRAM-OC editor round trip (b580 only) ----------------
    // The Advanced toggle: the b580 mock boots ADVANCED (the mock default) -
    // the pill shows Advanced active; the Advanced section holds the VRAM
    // clock editor (slider 0..3 Gbps step 0.1). Slide 1.5 -> Apply -> the
    // read-back + the toast carry 1.5 Gbps; restore 0.
    if (!(await waitFor(win, `Array.from(document.querySelectorAll('.oc-mode-btn')).some((b) => b.textContent.trim() === 'Advanced' && b.classList.contains('active'))`, 5000))) {
      fail('M4J (D): the b580 OC-mode pill does not show Advanced active (mock default)');
    }
    const setVramSlider = (value) => js(`(() => {
      const card = document.querySelector('.vram-editor-card');
      if (!card) return 'no-editor';
      const input = card.querySelector('input[type="range"]');
      input.value = '${value}';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return (card.querySelector('.oc-value')?.textContent ?? '').trim();
    })()`);
    const vramReadout = await setVramSlider(1.5);
    if (vramReadout !== '1.5 Gbps') fail(`M4J (D): the VRAM slider readout is '${vramReadout}' (expected '1.5 Gbps' - the vramFreqOffsetGts units)`);
    await clearToasts();
    await js(`Array.from(document.querySelectorAll('.vram-editor-card button')).find((b) => b.textContent.trim() === 'Apply')?.click()`);
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4J (D): the VRAM clock apply success toast missing');
    if (await js(`!!document.querySelector('.toast-error')`)) fail('M4J (D): the VRAM clock apply showed an error toast');
    const vramToast = await js(`document.querySelector('.toast-success .toast-message')?.textContent ?? ''`);
    if (!vramToast.includes('1.5 Gbps')) fail(`M4J (D): the VRAM clock success toast is '${vramToast}' (expected the applied '1.5 Gbps')`);
    const vramApplied = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(vramApplied.vramFreqOffsetGts - 1.5) > 1e-6) {
      fail(`M4J (D): the VRAM clock apply did not stick: ${vramApplied.vramFreqOffsetGts} (expected 1.5 Gbps)`);
    }
    const vramDriver = await js(`document.querySelector('.vram-editor-driver')?.textContent ?? ''`);
    if (!vramDriver.includes('1.5 Gbps')) fail(`M4J (D): the VRAM editor driver line is '${vramDriver}' (expected the read-back 1.5 Gbps)`);
    await clearToasts();
    await setVramSlider(0);
    await js(`Array.from(document.querySelectorAll('.vram-editor-card button')).find((b) => b.textContent.trim() === 'Apply')?.click()`);
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4J (D): the VRAM clock restore did not apply');
    const vramRestored = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(vramRestored.vramFreqOffsetGts) > 1e-6) {
      fail(`M4J (D): the VRAM clock restore did not land: ${vramRestored.vramFreqOffsetGts} (expected 0)`);
    }
    step('b580-vram-oc', `M4J (D): VRAM-OC editor round trip - Advanced active, slider 1.5 Gbps -> apply -> toast + read-back 1.5 Gbps, driver line '${vramDriver.trim()}', restored to 0`);
    await clearToasts();
  }

  // M4-D2 (§1): the shared close-to-tray REAL close probe - the LAST step.
  await runCloseToTrayProbe(win);

  console.log(`\nUI VERIFY OK (featureset: ${fsId})\n` + steps.map((s) => '  ' + s).join('\n'));
  app.exit(0);
}

// ---------------------------------------------------------------------------
// 1.0.1 - the no-intel variant (RID_MOCK_NO_INTEL=1)
// ---------------------------------------------------------------------------
//
// The no-Intel machine test round pinned end to end against the MOCK (the
// no-Intel session: listDevices [] + health igclLoaded false + the sysinfo
// fixture + the no-device telemetry push). M17d (Run B): run WITH
// RID_MOCK_VENDOR=nvml too - the sysinfo fixture then serves the GTX
// 980-class NVIDIA controller (SUBSYS_36811458 -> Gigabyte, 4 GiB VRAM,
// the resolved ReBAR verdict) and the vendor-lane fixture adapter feeds
// the live clocks + the deviceInfo() seam (the run WITHOUT the vendor knob
// fails loudly here: the live-clocks/Compute/Board-partner pins would read
// the honest '-'/unknown). The runFeaturesetVerify SHAPE, diverging BEFORE
// bootWaiverStep - the no-device boot NEVER prompts (caps/state are
// skipped), so no waiver modal may appear anywhere:
//   1. shell renders (sidebar + brand + mock badge) and the featureset
//      dropdown is HIDDEN (m5: the swap would store caps/state into the
//      no-Intel store);
//   2. the header shows the NVIDIA GTX 980 name + 'Non supported GPU'
//      (n10: the version line is replaced on no-Intel);
//   3. the health rows read 'No Intel Driver Found' (warn) + the GTX 980
//      name (warn) - NEVER the raw IGCL/error text (body-wide pin);
//   4. the CPU & Memory card renders the mock CPU fixture + the LIVE freq
//      half ('/ @ 4.3 GHz' from the no-device telemetry push);
//   5. the GPU card shows the GTX 980 name + the 'Non supported GPU' note
//      with the REAL rows: Board partner 'Gigabyte' (the PNP SUBSYS
//      decode - the M17c round-1-N3 absence pin INVERTS), Driver version,
//      Compute '2048 Cores' (the deviceInfo() seam), the LIVE Clocks
//      ('1965 MHz Core / 7010 MHz Memory' - the vendor lane sample), VRAM
//      '4GB' (the NVML total primary) + the ReBAR pill (real);
//   6. monitoring: the CPU utilization/temperature tiles get the mock
//      sys-stats values (the no-device push); the GPU device tiles go LIVE
//      from the vendor lane (core/mem clocks, VRAM used, VramTemp, temp,
//      power) with the OS Util counter still winning the Util tile;
//   7. the Tuning page shows 'No GPU available.' - NEVER the caps-loading
//      text (the deviceId-null branch must win over the caps guard);
//   8. NO waiver modal and NO toast anywhere in the session (the no-toast
//      pin runs BEFORE any clear, so a toast fired earlier in the session
//      fails the verify instead of being swallowed);
//   9. the close-to-tray REAL close probe - the LAST step.

/**
 * M17c (round-3 N2): the laptop-sysinfo variant (RID_MOCK_LAPTOP=1) - the
 * mock sysinfo fixture + the caps AIB decode BOTH serve the PORTABLE shape
 * (the MSI Claw: 'Micro-Star International Co., Ltd.' + a portable
 * chassis): the Dashboard Board partner row reads 'MSI (Claw 8 AI+)' (the
 * laptop-manufacturer branch - the subsystem decode is overridden on
 * portable systems). The close-to-tray probe is the LAST step.
 * @param {import('electron').BrowserWindow} win
 */
export async function runLaptopSysinfoVerify(win) {
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

  // --- 1. shell + the shared waiver boot step -------------------------------
  if (!(await waitFor(win, `document.querySelectorAll('.sidebar-link').length === 7`))) {
    fail('sidebar did not render (7 nav links expected)');
  }
  await bootWaiverStep(win, js, waitFor);
  step('waiver-boot', 'boot waiver prompt handled (cancelled - the unaccepted session)');

  // --- 2. the Board partner row reads the LAPTOP MANUFACTURER ---------------
  // The laptop branch overrides the subsystem decode on portable systems:
  // aibVendor = the CLEANED manufacturer (Micro-Star -> MSI), aibModel =
  // the system Model (Claw 8 AI+).
  await js(`location.hash = '#/dashboard'`);
  if (!(await waitFor(win, `(() => {
    const card = document.querySelector('.card-grid .device-card');
    const kvs = Array.from(card?.querySelectorAll('.kv') ?? []);
    const gpuIdx = kvs.findIndex((k) => (k.getAttribute('data-label') ?? '') === 'GPU');
    const aibIdx = kvs.findIndex((k) => (k.getAttribute('data-label') ?? '') === 'Board partner');
    const aibRow = kvs[aibIdx];
    return aibIdx === gpuIdx + 1 && !!aibRow && (aibRow.textContent ?? '').trim() === 'MSI (Claw 8 AI+)';
  })()`, 10000))) {
    fail(`M17c: the laptop Board partner row is '${await js(`document.querySelector('.card-grid .device-card .kv[data-label="Board partner"]')?.textContent ?? ''`)}' (expected 'MSI (Claw 8 AI+)' - the cleaned laptop manufacturer + model)`);
  }
  // The caps payload carries the laptop-branch identity (the same payload
  // the device-limits table + the renderer pin key on).
  const caps = await js(`window.arcPower.getCapabilities(0)`);
  if (caps.aibVendor !== 'MSI' || caps.aibModel !== 'Claw 8 AI+') {
    fail(`M17c: the laptop caps AIB fields are ${JSON.stringify({ aibVendor: caps.aibVendor, aibModel: caps.aibModel })} (expected 'MSI' / 'Claw 8 AI+')`);
  }
  step('laptop-board-partner', `Board partner row 'MSI (Claw 8 AI+)' (the laptop-manufacturer branch - the cleaned MSI + the system Model; caps carry the same identity)`);

  // --- 3. the close-to-tray REAL close probe - the LAST step ----------------
  await runCloseToTrayProbe(win);

  console.log('\nUI VERIFY OK (laptop-sysinfo)\n' + steps.map((s) => '  ' + s).join('\n'));
  app.exit(0);
}

/**
 * @param {import('electron').BrowserWindow} win
 */
export async function runNoIntelVerify(win) {
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

  // --- 1. shell renders ----------------------------------------------------
  if (!(await waitFor(win, `document.querySelectorAll('.sidebar-link').length === 7`))) {
    fail('sidebar did not render (7 nav links expected - the Overlay tab moved into Monitoring in M9)');
  }
  const brand = await js(`document.querySelector('.sidebar-brand')?.textContent ?? ''`);
  if (!brand.trim().includes('Arc Power')) fail(`sidebar brand is '${brand}'`);
  step('shell', `shell rendered; brand '${brand.trim()}'`);

  // --- 2. the header: the NVIDIA name + 'Non supported GPU' (n10) ----------
  // M17d (Run B): the no-intel+nvml variant serves the GTX 980-class
  // fixture (RID_MOCK_NO_INTEL=1 + RID_MOCK_VENDOR=nvml) - the OS GPU is
  // the NVIDIA part now (the previous AMD RX 7600 pins INVERT).
  if (!(await waitFor(win, `(document.querySelector('.gpu-name')?.textContent ?? '').trim() === 'NVIDIA GeForce GTX 980'`, 10000))) {
    fail(`M17d: the header GPU name is '${await js(`document.querySelector('.gpu-name')?.textContent ?? ''`)}' (expected the OS GPU 'NVIDIA GeForce GTX 980' - the GTX 980-class fixture)`);
  }
  const gpuMeta = await js(`document.querySelector('.gpu-meta')?.textContent ?? ''`);
  if (gpuMeta.trim() !== 'Non supported GPU') {
    fail(`1.0.1: the header meta is '${gpuMeta}' (expected 'Non supported GPU' replacing the version line - n10)`);
  }
  // m5: the featureset dropdown is HIDDEN once the noIntel flag landed (a
  // swap would store caps/state into the no-Intel store); the mock badge
  // stays (the honest backend kind).
  if (await js(`!!document.querySelector('.featureset-select')`)) {
    fail('1.0.1 (m5): the featureset dropdown must be HIDDEN on the no-Intel path (a swap would store caps/state into the no-Intel store)');
  }
  if (!(await js(`!!document.querySelector('.badge-mock')`))) fail('mock badge missing (the backend kind is still honest)');
  step('header', `header: 'NVIDIA GeForce GTX 980' + 'Non supported GPU' (the version line is replaced on no-Intel - n10; the M17d GTX 980-class fixture); dropdown hidden (m5), mock badge kept`);

  // --- 3. the health rows: honest no-Intel texts, NEVER the raw errors ------
  if (!(await waitFor(win, `document.querySelectorAll('.health-card').length === 1`, 10000))) {
    fail('expected exactly one GPU Status card');
  }
  if (await js(`document.querySelectorAll('.health-card .health-row').length !== 5`)) {
    fail(`health card rows: got ${await js(`document.querySelectorAll('.health-card .health-row').length`)} (expected 5)`);
  }
  const rowIds = await js(`Array.from(document.querySelectorAll('.health-card .health-row')).map((r) => r.dataset.row).join(',')`);
  if (rowIds !== 'device,driver,oc,waiver,app') fail(`health card rows are '${rowIds}' (expected device,driver,oc,waiver,app - the M16 flip puts the device row FIRST)`);
  const driverDetail = await js(`document.querySelector('.health-card .health-row[data-row="driver"] .health-row-detail')?.textContent ?? ''`);
  if (driverDetail.trim() !== 'No Intel Driver Found') {
    fail(`1.0.1: the driver row reads '${driverDetail}' (expected 'No Intel Driver Found' - NEVER the raw IGCL/error text)`);
  }
  const driverDot = await js(`document.querySelector('.health-card .health-row[data-row="driver"] .status-dot')?.className ?? ''`);
  if (!/status-warn/.test(driverDot)) fail(`1.0.1: the driver row dot is '${driverDot}' (expected warn)`);
  const deviceDetail = await js(`document.querySelector('.health-card .health-row[data-row="device"] .health-row-detail')?.textContent ?? ''`);
  if (deviceDetail.trim() !== 'NVIDIA GeForce GTX 980') {
    fail(`M17d: the device row reads '${deviceDetail}' (expected the OS GPU name 'NVIDIA GeForce GTX 980' - the GTX 980-class fixture)`);
  }
  const deviceDot = await js(`document.querySelector('.health-card .health-row[data-row="device"] .status-dot')?.className ?? ''`);
  if (!/status-warn/.test(deviceDot)) fail(`1.0.1: the device row dot is '${deviceDot}' (expected warn)`);
  // Body-wide: NO raw IGCL/error text anywhere, no boot-error text.
  const body = await js(`document.body.textContent`);
  if (body.includes('IGCL')) fail('1.0.1: the raw IGCL text is still rendered somewhere');
  if (body.includes('DLL not found')) fail('1.0.1: the raw DLL error text is still rendered somewhere');
  if (body.includes('No Intel Arc GPU detected')) fail('1.0.1: the old boot-error line is still rendered');
  step('health', `health card: driver 'No Intel Driver Found' (warn), device 'NVIDIA GeForce GTX 980' (warn); no IGCL/error text anywhere`);

  // --- 4. the CPU & Memory card renders (the sysinfo fixture) ---------------
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('.card-grid > .card')).some((c) => (c.querySelector('.card-title')?.textContent ?? '') === 'CPU & Memory')`, 5000))) {
    fail('1.0.1: the CPU & Memory card did not render on the no-Intel path');
  }
  const sysRows = await js(`JSON.stringify(Object.fromEntries(Array.from(document.querySelectorAll('.sysinfo-card .kv')).map((k) => [k.getAttribute('data-label'), (k.textContent ?? '').trim()])))`);
  const rows = JSON.parse(sysRows);
  if (rows['CPU'] !== 'Intel(R) Core(TM) i7-14700K') fail(`1.0.1: the CPU row is '${rows['CPU']}'`);
  // M4-H (C2)/M4J (B)/M4L (A): the no-Intel path shares the fixture - DDR5
  // in the memory line + the 'Mainboard' row (the Cache row is gone).
  // M4L INVERTS the M4J always-GHz pin back to MHz ("@ 6000 MHz" - the
  // mock's 6000 MHz; the '@ ' prefix kept; documented like the M4-I
  // driver-row inversion).
  if (rows['Memory'] !== 'G.Skill 32 GB DDR5 @ 6000 MHz') fail(`1.0.1/M4L: the Memory row is '${rows['Memory']}' (expected 'G.Skill 32 GB DDR5 @ 6000 MHz' - the M4J GHz pin is INVERTED back to MHz)`);
  if (rows['Mainboard'] !== 'ASUSTeK MAXIMUS VII RANGER') {
    fail(`M4J: the no-Intel Mainboard row is '${rows['Mainboard']}' (expected 'ASUSTeK MAXIMUS VII RANGER')`);
  }
  if (rows['Cache'] !== undefined || rows['Caches'] !== undefined) {
    fail(`M4J: the no-Intel Cache row is still rendered (removed - got ${Object.keys(rows).join(',')})`);
  }
  // The LIVE freq half from the no-device telemetry push (cpuFreqMhz 4300).
  if (!(await waitFor(win, `(document.querySelector('.sysinfo-card .kv[data-label="Cores / Clock"]')?.textContent ?? '').trim() === '20 Cores / 28 Threads / @ 4.3 GHz'`, 8000))) {
    fail(`1.0.1: the Cores / Clock row is '${await js(`document.querySelector('.sysinfo-card .kv[data-label="Cores / Clock"]')?.textContent ?? ''`)}' (expected the static bundle + the LIVE '/ @ 4.3 GHz')`);
  }
  step('cpu-card', `CPU & Memory card renders: '${rows['CPU']}', '20 Cores / 28 Threads / @ 4.3 GHz' (live from the no-device push), '${rows['Memory']}', Mainboard '${rows['Mainboard']}' (Cache row removed)`);

  // --- 5. the GPU card (M4-H + M4-I + M17d): title 'GPU' + the OS GPU in
  // --- the 'GPU' kv row, 'Non supported GPU' note, and the REAL rows the
  // --- OS + the vendor lane have: Board partner (the PNP SUBSYS decode -
  // --- 'Gigabyte' for SUBSYS_36811458 - works for ANY GPU), Driver version
  // --- (the videoControllers driverVersion field), Compute (the
  // --- deviceInfo() core count - '2048 Cores'), Clocks LIVE (the vendor
  // --- lane sample - '1965 MHz Core / 7010 MHz Memory'), VRAM (the
  // --- deviceInfo() NVML total - '4GB'), ReBAR pill REAL (the OS
  // --- pnputil/allocated sources are GPU-agnostic). NOTE: this REVERSES
  // --- the M4-H pin that asserted the driver row's ABSENCE, the M17c
  // --- round-1-N3 pin that asserted the Board-partner row's ABSENCE on the
  // --- no-Intel branch AND the M4-I static '-' Compute/Clocks pins - the
  // --- inversions are explicit (the M17d no-Intel rows are real).
  const gpuCardTitle = await js(`document.querySelector('.device-card .card-title')?.textContent ?? ''`);
  if (gpuCardTitle.trim() !== 'GPU') fail(`M4-H: the GPU card title is '${gpuCardTitle}' (expected 'GPU' - the name lives in the kv row)`);
  const gpuNameKv = await js(`document.querySelector('.device-card .kv[data-label="GPU"]')?.textContent ?? ''`);
  if (gpuNameKv.trim() !== 'NVIDIA GeForce GTX 980') fail(`M17d: the GPU card name row is '${gpuNameKv}' (expected the OS GPU name 'NVIDIA GeForce GTX 980' - the GTX 980-class fixture)`);
  // M17d: the Board-partner row BELOW the GPU row - the controller
  // PNPDeviceID SUBSYS decode (SUBSYS_36811458 -> subsys vendor 0x1458 =
  // Gigabyte) - the round-1-N3 absence pin is INVERTED.
  if (!(await waitFor(win, `(() => {
    const card = document.querySelector('.card-grid .device-card');
    const kvs = Array.from(card?.querySelectorAll('.kv') ?? []);
    const gpuIdx = kvs.findIndex((k) => (k.getAttribute('data-label') ?? '') === 'GPU');
    const aibIdx = kvs.findIndex((k) => (k.getAttribute('data-label') ?? '') === 'Board partner');
    const aibRow = kvs[aibIdx];
    return aibIdx === gpuIdx + 1 && !!aibRow && (aibRow.textContent ?? '').trim() === 'Gigabyte';
  })()`, 10000))) {
    fail(`M17d: the no-Intel Board partner row is '${await js(`document.querySelector('.device-card .kv[data-label="Board partner"]')?.textContent ?? ''`)}' (expected 'Gigabyte' directly below the GPU row - the SUBSYS_36811458 -> 0x1458 decode)`);
  }
  const driverRowKv = await js(`document.querySelector('.device-card .kv[data-label="Driver version"]')?.textContent ?? ''`);
  if (!driverRowKv.includes('31.0.15.6262')) {
    fail(`M4-I (D3): the no-Intel Driver version row is '${driverRowKv}' (expected the controller driverVersion '31.0.15.6262' - the M4-H absence pin is REVERSED)`);
  }
  // M17d: the Compute row - the deviceInfo() core count ('2048 Cores' from
  // the nvml fixture's numCores - the honest '-' only when the lane has no
  // source).
  const computeRowKv = await js(`document.querySelector('.device-card .kv[data-label="Compute"]')?.textContent ?? ''`);
  if (computeRowKv.trim() !== '2048 Cores') {
    fail(`M17d: the no-Intel Compute row is '${computeRowKv}' (expected '2048 Cores' - the NVML numGpuCores via the deviceInfo() seam)`);
  }
  const vramRowKv = await js(`document.querySelector('.device-card .kv[data-label="VRAM"]')?.textContent ?? ''`);
  if (vramRowKv.trim() !== '4GB') {
    fail(`M17d: the no-Intel VRAM row is '${vramRowKv}' (expected '4GB' - the deviceInfo() NVML total primary, 4 GiB on the GTX 980-class)`);
  }
  // M17d: the Clocks row goes LIVE from the vendor lane sample (the static
  // '- MHz Core / - MHz Memory' is replaced on ticks - the M4-I pin
  // INVERTS to the live values).
  if (!(await waitFor(win, `(document.querySelector('.device-card .kv[data-label="Clocks"]')?.textContent ?? '').trim() === '1965 MHz Core / 7010 MHz Memory'`, 8000))) {
    fail(`M17d: the no-Intel Clocks row is '${await js(`document.querySelector('.device-card .kv[data-label="Clocks"]')?.textContent ?? ''`)}' (expected the LIVE vendor lane '1965 MHz Core / 7010 MHz Memory' - NVML clock graphics + NVML_CLOCK_MEM)`);
  }
  if (!(await waitFor(win, `(() => {
    const pill = document.querySelector('.device-card .rebar-pill');
    return !!pill && pill.textContent === 'ReBAR off' && pill.className.includes('status-error');
  })()`, 5000))) {
    fail(`M4-I (D3): the no-Intel ReBAR pill must be REAL (the GTX 980-class fixture rebarActive false -> red 'ReBAR off'): '${await js(`document.querySelector('.device-card .rebar-pill')?.textContent ?? ''`)}'`);
  }
  const gpuCardText = await js(`document.querySelector('.device-card')?.textContent ?? ''`);
  if (!gpuCardText.includes('Non supported GPU')) fail('1.0.1: the GPU card is missing the "Non supported GPU" note');
  step('gpu-card', `GPU card: title 'GPU', name row 'NVIDIA GeForce GTX 980', Board partner 'Gigabyte' below the GPU row (the SUBSYS_36811458 -> 0x1458 decode - the round-1-N3 absence pin REVERSED), Driver version row '${driverRowKv.trim()}', Compute '${computeRowKv.trim()}', Clocks live '1965 MHz Core / 7010 MHz Memory', VRAM '${vramRowKv.trim()}' (the NVML total), ReBAR 'ReBAR off' (real), 'Non supported GPU' note`);

  // M7b (fix 1): the no-Intel sysinfo FIXTURE carries a 'Microsoft Basic
  // Display Adapter' FIRST + a DisplayLink dock (the fixture path bypasses
  // the parse - createMockSysinfo applies isRealGpuController itself). The
  // header / health device row / GPU card pins above already show the real
  // NVIDIA part; THIS pin proves the PAYLOAD never carries the non-GPU
  // devices - a first-controller Basic Display Adapter must never win the
  // GPU card / health row / header name.
  const sysinfoPayload = await js(`window.arcPower.sysinfo()`);
  const payloadControllers = Array.isArray(sysinfoPayload?.videoControllers) ? sysinfoPayload.videoControllers : [];
  if (payloadControllers.length !== 1 || payloadControllers[0].name !== 'NVIDIA GeForce GTX 980') {
    fail(`M7b: the no-Intel sysinfo payload must carry ONLY the real NVIDIA part (got ${JSON.stringify(payloadControllers.map((c) => c.name))} - the Basic Display Adapter + DisplayLink must be filtered)`);
  }
  // M17d (round-1 S2): the payload's controller carries pnpDeviceId (the
  // Board-partner SUBSYS decode source for ANY GPU).
  if (payloadControllers[0].pnpDeviceId !== 'PCI\\VEN_10DE&DEV_13C2&SUBSYS_36811458&REV_A1') {
    fail(`M17d: the no-Intel controller payload must carry the PNPDeviceID (got ${JSON.stringify(payloadControllers[0].pnpDeviceId)} - the Board-partner decode source)`);
  }
  step('m7b-gpu-filter', `M7b: the no-Intel sysinfo payload carries ONLY 'NVIDIA GeForce GTX 980' (the Basic Display Adapter FIRST + DisplayLink were filtered by isRealGpuController) + the pnpDeviceId rides along (the M17d SUBSYS decode source)`);

  // --- 6. monitoring: the OS-level tiles + the LIVE vendor readouts -------
  // M4M (B): the two groups are SCOPED lookups (both carry Temperature-like
  // labels); the CPU group's 'Util' replaces the old 'CPU utilization'
  // label, and the CPU 'Temperature' tile reads cpuTempC (the 'CPU
  // temperature' label is gone).
  // M17d (Run B): the vendor lane (RID_MOCK_VENDOR=nvml) fills the GPU
  // device tiles - Core clock '1965' + Memory clock '7010' (the live
  // clocks), VramTemp '58' (the NVML field-values read), Temperature '62',
  // Power '152.4', Fan '1240' - and the VRAM tile reads the NVML used-VRAM
  // (4 GiB -> '4.3' GB, the gbValue format). The M4-I '-' static pins
  // INVERT.
  await js(`location.hash = '#/monitoring'`);
  await sleep(250);
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('#mon-readout-cpu .stat-tile')).find((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'Util')?.querySelector('.stat-value')?.textContent === '42'`, 8000))) {
    fail('1.0.1: the monitoring CPU Util tile is not 42 % (the no-device sys-stats push)');
  }
  const monCpuTiles = await js(`JSON.stringify(Object.fromEntries(Array.from(document.querySelectorAll('#mon-readout-cpu .stat-tile')).map((t) => [(t.querySelector('.stat-label')?.textContent ?? '').trim(), (t.querySelector('.stat-value')?.textContent ?? '').trim()])))`);
  const monGpuTiles = await js(`JSON.stringify(Object.fromEntries(Array.from(document.querySelectorAll('#mon-readout-gpu .stat-tile')).map((t) => [(t.querySelector('.stat-label')?.textContent ?? '').trim(), (t.querySelector('.stat-value')?.textContent ?? '').trim()])))`);
  const cpu = JSON.parse(monCpuTiles);
  const gpu = JSON.parse(monGpuTiles);
  // M4-I (C1): the mock temp VARIES 61/62 - accept either.
  if (cpu['Temperature'] !== '61' && cpu['Temperature'] !== '62') {
    fail(`1.0.1: the CPU Temperature tile is '${cpu['Temperature']}' (expected 61|62 - the varying mock)`);
  }
  // M17d: the VRAM tile reads the NVML used-VRAM now (4 GiB -> '4.3' GB -
  // the M4M '3.0' sys-stats pin INVERTS; the vendor readouts win the
  // composition).
  if (gpu['VRAM'] !== '4.3') fail(`M17d: the VRAM tile is '${gpu['VRAM']}' (expected '4.3' GB from the NVML used-VRAM 4294967296 bytes)`);
  if (gpu['Core clock'] !== '1965') fail(`M17d: the core-clock tile is '${gpu['Core clock']}' (expected '1965' - the LIVE NVML clock graphics; the M4-I '-' pin INVERTS)`);
  if (gpu['Memory clock'] !== '7010') fail(`M17d: the memory-clock tile is '${gpu['Memory clock']}' (expected '7010' - the LIVE NVML_CLOCK_MEM)`);
  if (gpu['VramTemp'] !== '58') fail(`M17d: the VRAM-temp tile is '${gpu['VramTemp']}' (expected '58' - the NVML_FI_DEV_MEMORY_TEMP field-values read)`);
  if (gpu['Temperature'] !== '62') fail(`M17d: the GPU temperature tile is '${gpu['Temperature']}' (expected '62' - the NVML temp)`);
  if (gpu['Power'] !== '152.4') fail(`M17d: the GPU power tile is '${gpu['Power']}' (expected '152.4' - the NVML mW->W readout)`);
  // M4-I (D4): the Util tile reads `gpuUtilPct ?? utilPct` - on no-Intel the
  // OS GPUEngine counter (the mock's fixed 42) is the only source (the
  // NVML util is utilPct - the OS counter wins the ??:).
  if (gpu['Util'] !== '42') fail(`1.0.1/M4-I: the monitoring Util tile is '${gpu['Util']}' (expected 42 - gpuUtilPct from the no-device sys-stats push)`);
  step('monitoring', `monitoring: CPU Util 42 %, CPU Temperature ${cpu['Temperature']} °C; GPU tiles LIVE from the vendor lane - Core clock 1965, Memory clock 7010, VRAM 4.3 GB (the NVML used-VRAM), VramTemp 58, Temperature 62, Power 152.4 W, Util 42 % (M4-I: gpuUtilPct ?? utilPct)`);

  // --- 7. the Tuning page: 'No GPU available.', never the caps-loading text --
  // deviceId is null on no-Intel: the page must present the honest no-device
  // text, NEVER 'Loading device capabilities…' (the caps guard previously
  // shadowed the deviceId-null guard - a perpetual loading screen).
  await js(`location.hash = '#/tuning'`);
  if (!(await waitFor(win, `(document.querySelector('.page-subtitle')?.textContent ?? '').trim() === 'No GPU available.'`, 5000))) {
    fail(`1.0.1: the Tuning page reads '${await js(`document.querySelector('.page-subtitle')?.textContent ?? ''`)}' (expected 'No GPU available.' - the deviceId-null branch must win over the caps guard)`);
  }
  const tuningBody = await js(`document.body.textContent`);
  if (tuningBody.includes('Loading device capabilities')) {
    fail('1.0.1: the Tuning page shows the caps-loading text on no-Intel (no caps fetch can ever land on this path - the page must say No GPU available.)');
  }
  step('tuning', `Tuning page: 'No GPU available.' (deviceId null - never 'Loading device capabilities…')`);

  // --- 7b. M8: the Graphics tab on the no-Intel path -------------------------
  // The same deviceId-null guard (plan-review S3): the page says 'No GPU
  // available.' and NEVER calls graphics:get with a null deviceId
  // (assertValidDeviceId throws - the renderer guard renders first).
  await js(`location.hash = '#/graphics'`);
  await sleep(250);
  if (!(await waitFor(win, `(document.querySelector('.page-subtitle')?.textContent ?? '').trim() === 'No GPU available.'`, 5000))) {
    fail(`M8: the Graphics page reads '${await js(`document.querySelector('.page-subtitle')?.textContent ?? ''`)}' on the no-Intel path (expected 'No GPU available.' - the deviceId-null guard must win)`);
  }
  if ((await js(`document.body.textContent`)).includes('Loading graphics capabilities')) {
    fail('M8: the Graphics page shows the loading text on no-Intel (no graphics:get fetch can ever land - the guard renders first)');
  }
  // The renderer must never even TRY: graphics:get with a null deviceId is
  // rejected in main (assertValidDeviceId) - the honest channel contract.
  const gNull = await js(`(async () => { try { await window.arcPower.graphicsGet(null); return 'accepted'; } catch (e) { return 'rejected'; } })()`);
  if (gNull !== 'rejected') fail(`M8: graphics:get(null) must be rejected in main (assertValidDeviceId), got '${gNull}'`);
  step('m8-no-intel', `M8: the Graphics tab on no-Intel shows 'No GPU available.' (never 'Loading graphics capabilities…'); graphics:get(null) rejects in main (assertValidDeviceId)`);

  // --- 8. NO waiver modal and NO toast anywhere -----------------------------
  await js(`location.hash = '#/dashboard'`);
  await sleep(400);
  // The no-toast pin runs BEFORE any clear: a toast that fired earlier in
  // the session (e.g. during boot) must FAIL the verify, not be swallowed.
  if (await js(`!!document.querySelector('.toast')`)) {
    fail(`1.0.1: a toast appeared on the no-Intel path: '${await js(`Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent).join(' | ')`)}'`);
  }
  await clearToasts();
  await sleep(1200); // cover a couple of telemetry ticks + any delayed boot flow
  if (await js(`!!document.querySelector('.modal')`)) {
    fail('1.0.1: a modal appeared on the no-Intel path (the no-device boot never prompts - caps/state are skipped)');
  }
  if (await js(`!!document.querySelector('.toast')`)) {
    fail(`1.0.1: a toast appeared on the no-Intel path: '${await js(`Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent).join(' | ')`)}'`);
  }
  step('silent', 'no waiver modal, no toast anywhere (the no-device boot is silent)');

  // M4-D2 (§1): the shared close-to-tray REAL close probe - the LAST step.
  await runCloseToTrayProbe(win);

  console.log('\nUI VERIFY OK (no-intel)\n' + steps.map((s) => '  ' + s).join('\n'));
  app.exit(0);
}

// ---------------------------------------------------------------------------
// M3-B - tweaks-apply variant (RID_MOCK_TWEAKS_APPLY=1)
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

  // M6: 7 nav links (the Overlay Settings page joined the sidebar). M8: 8
  // (the Graphics tab joined below Tuning). M9: 7 again (the Overlay tab
  // moved into the Monitoring page's Overlay view).
  if (!(await waitFor(win, `document.querySelectorAll('.sidebar-link').length === 7`))) {
    fail('sidebar did not render (7 nav links expected - the Overlay tab moved into Monitoring in M9)');
  }
  // M4-A/M4-B: the shared waiver boot-step - the boot prompt appears in
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
    if (!/Nothing was rolled back automatically - use Revert/.test(msg)) fail(`partial-failure toast misses the no-auto-revert note: '${msg}'`);
    // The state refresh reflects what actually landed: the knob fails at the
    // action's LAST step (the mock clamps it there), so for mpo enable the
    // HKLM hive landed (MPOHack=1 -> 'Active') while the failing HKCU step
    // never ran. The two single-step actions (hags/game-dvr) fail their only
    // step -> nothing lands, the fixture state stays.
    if ((await stateLabelOf(failEntry)).trim() !== 'Active') fail(`partial apply state is '${await stateLabelOf(failEntry)}' (expected Active - the landed HKLM hive)`);
    await clearToasts();
    // The user can still Revert (a real revert works - the failure knob is
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

  // M4-D2 (§1): the shared close-to-tray REAL close probe - the LAST step.
  await runCloseToTrayProbe(win);

  console.log(`\nUI VERIFY OK (tweaks-apply${failKnob ? `, fail=${failKnob}` : ''}${cancelKnob ? ', cancel' : ''})\n` + steps.map((s) => '  ' + s).join('\n'));
  app.exit(0);
}

// ---------------------------------------------------------------------------
// M4-A - fan-gate regression variant (RID_MOCK_FAN_GATE=1)
// ---------------------------------------------------------------------------
//
// The report: fan-curve applies FAIL without a waiver prompt. This
// variant regression-tests the unaccepted-waiver fan apply through the mock
// (the fan editor is the product apply surface - the dialog gate lives in
// the renderer, so it is exercised end-to-end here, not unit-testable):
//   1. unaccepted boot (shared boot-step cancels the boot prompt); the
//      dashboard health-card waiver row reads Not Accepted (red, clickable);
//   2. first fan apply: the waiver dialog appears -> Cancel -> the apply is
//      ABORTED with the honest info toast and the device stays untouched;
//   3. second fan apply: dialog -> Accept -> the apply LANDS (read-back
//      reflects the edited curve) and the dashboard waiver row flips green;
//   4. M4-D (PERMANENT acceptance): with the store ACCEPTED (the Accept
//      above), the driver losing the waiver mid-session (injected one-shot
//      waiver-not-set) is handled SILENTLY in main - the apply re-sets the
//      driver waiver + retries ONCE (no dialog, no error), the read-back
//      lands, and the dashboard waiver row stays green (the consent stands;
//      the store is never flipped to false).
// The packaged always-elevated path applies in-process (waiver-accept +
// apply run inside the EXE - pinned by elevated-apply.test.js); this
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

  // M6: 7 nav links (the Overlay Settings page joined the sidebar). M8: 8
  // (the Graphics tab joined below Tuning). M9: 7 again (the Overlay tab
  // moved into the Monitoring page's Overlay view).
  if (!(await waitFor(win, `document.querySelectorAll('.sidebar-link').length === 7`))) {
    fail('sidebar did not render (7 nav links expected - the Overlay tab moved into Monitoring in M9)');
  }
  // M4-A/M4-B: the shared boot-step - the session boots unaccepted -> the
  // boot prompt appears exactly once -> Cancel it (the fan gate below then
  // sees a clean page with a still-unaccepted waiver).
  await bootWaiverStep(win, js, waitFor);
  step('waiver-boot', 'boot waiver prompt handled (cancelled - the fan gate runs unaccepted)');

  const pointsCount = () => js(`document.querySelectorAll('.fan-dot').length`);
  const clickApply = () => js(`(() => { const b = Array.from(document.querySelectorAll('#page button')).find((b) => b.textContent.includes('Apply fan settings')); if (!b) return false; b.click(); return true; })()`);
  const clickRemove = () => js(`(() => { const b = Array.from(document.querySelectorAll('#page button')).find((b) => b.textContent.includes('Remove point')); if (!b) return false; b.click(); return true; })()`);
  // M4-A (correction): the waiver STATUS lives ONLY in the dashboard
  // GPU Status card - assert the row state there (red + clickable while
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
  // The dashboard row flipped green - the accept-time + post-apply store
  // re-sets trigger the caps-change re-render.
  await goDashboard('fan-gate-row-accepted');
  await expectRow('Accepted', false);
  if (!/status-ok/.test(await rowDotOk())) fail('M4-A: the waiver row dot is not green once accepted');
  if ((await js(`window.arcPower.waiverGet(0)`)).accepted !== true) fail('waiver not accepted on the device after the fan Accept');
  step('fan-gate-accept', `Accept -> apply landed (${landed.fanCurve?.length} points read back), dashboard waiver row flipped to Accepted (green, not clickable)`);
  await goFan();

  // --- 4. M4-D: the driver loses the waiver mid-session (accepted store) ---
  // The injected ONE-SHOT waiver-not-set mirrors the real driver losing the
  // waiver. M4-D (PERMANENT acceptance): with the persisted
  // acceptance TRUE (the fan Accept above), a waiver-not-set apply is
  // SILENTLY re-set + retried ONCE in main - never a dialog, never a
  // dead-end, never a persisted false. The dashboard row stays green (the
  // consent stands - the M4-B "flip to unaccepted + re-prompt" behavior is
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

  // M4-D2 (§1): the shared close-to-tray REAL close probe - the LAST step.
  await runCloseToTrayProbe(win);

  console.log('\nUI VERIFY OK (fan-gate)\n' + steps.map((s) => '  ' + s).join('\n'));
  app.exit(0);
}

// ---------------------------------------------------------------------------
// M4M (F7) - boot-apply variant (RID_MOCK_BOOT_APPLY=1)
// ---------------------------------------------------------------------------
//
// The session seed wrote ocOnBoot:true + activeProfileId 'boot-apply-probe'
// + waiverAccepted:true (+ the profile itself: powerLimitW 230) into the
// ISOLATED mock store, so the WINDOW-PATH automatic apply (moved BEFORE
// createWindow in M4M - the ordering fix) ran at boot. This runner asserts:
//   (a) mock:boot-apply-log has EXACTLY ONE entry with applied:true + the
//       probe profile id (the automatic apply ran once, never twice);
//   (b) the renderer's FIRST state read is the POST-apply state: the tuning
//       page's powerLimit slider + driver readout reflect 230 W - THE
//       regression assertion for the ordering fix (the old post-window
//       position made even a successful apply invisible in that launch).

/**
 * @param {import('electron').BrowserWindow} win
 * @param {import('./backend/mock-backend.js').MockBackend} backend
 * @param {import('./store/profile-store.js').ProfileStore} store
 */
export async function runBootApplyVerify(win, backend, store) {
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

  // The seed wrote waiverAccepted:true - the boot prompt is SKIPPED
  // entirely (the M4-D permanent-acceptance shape). Assert the boot
  // sequence landed (the dashboard health card renders after caps arrive)
  // and no modal ever appeared.
  if (!(await waitFor(win, `document.querySelectorAll('.health-card').length === 1`, 15000))) {
    fail(`M4M: the boot-apply session did not land the dashboard health card: page='${(await js(`(document.getElementById('page')?.textContent ?? '').slice(0, 200)`))}'`);
  }
  await sleep(600);
  if (await js(`!!document.querySelector('.modal')`)) {
    fail('M4M: the boot waiver prompt appeared in the boot-apply session (the seed wrote waiverAccepted:true - the boot prompt must be skipped)');
  }
  step('boot-apply-waiver', 'boot-apply session: the seeded acceptance skips the boot prompt entirely');

  // (a) the automatic window-path apply recorded EXACTLY ONE entry.
  const bootLog = await js(`window.arcPower.mockBootApplyLog()`);
  if (!Array.isArray(bootLog) || bootLog.length !== 1) {
    fail(`M4M: the mock boot-apply log has ${Array.isArray(bootLog) ? bootLog.length : 'no'} entry (expected exactly ONE - the automatic window-path apply): ${JSON.stringify(bootLog)}`);
  }
  const entry = bootLog[0];
  if (entry.applied !== true || entry.profileId !== 'boot-apply-probe') {
    fail(`M4M: the boot-apply log entry is ${JSON.stringify(entry)} (expected { profileId: 'boot-apply-probe', applied: true } - the automatic apply with the seeded profile)`);
  }
  step('boot-apply-log', `mock:boot-apply-log records the automatic apply: ${JSON.stringify(entry)}`);

  // (b) the POST-apply state read - the ordering-fix regression: the apply
  // ran BEFORE createWindow, so the tuning page's FIRST state read shows
  // the applied profile (powerLimit 230 W).
  await js(`location.hash = '#/tuning'`);
  if (!(await waitFor(win, `!!document.querySelector('.oc-mode-row')`, 8000))) {
    fail('M4M: the tuning page shell did not render');
  }
  if (!(await waitFor(win, `(document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value')?.textContent ?? '').trim() === '230 W'`, 8000))) {
    fail(`M4M: the powerLimit slider does not reflect the boot-applied 230 W: '${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value')?.textContent ?? ''`)}' (the apply must run BEFORE createWindow)`);
  }
  const bootDriverLine = await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-driver-value')?.textContent ?? ''`);
  if (bootDriverLine.trim() !== '230 W') {
    fail(`M4M: the powerLimit Driver readout is '${bootDriverLine}' (expected '230 W' - the post-apply state read-back)`);
  }
  step('boot-apply-post-state', `tuning shows the POST-apply state: powerLimit slider + Driver readout '230 W' (the ordering-fix regression)`);

  // M4N (A.1) + M16: the boot-apply OUTCOME reached the renderer - the
  // dashboard OC status row is GREEN and reads the M16 STOCK-STATE text:
  // the boot-applied 230 W differs from the 210 W stock default, so the
  // row must read 'Overclock Applied' (the last-apply profile NAME is no
  // longer displayed in the row - the record is pinned via
  // window.arcPower.bootApplyOutcome() below). The status-ok class sits on
  // the inner .status-dot, not the row element.
  await js(`location.hash = '#/dashboard'`);
  if (!(await waitFor(win, `!!document.querySelector('.health-row[data-row="oc"] .status-dot.status-ok')`, 8000))) {
    fail(`M4N: the OC status row is not green after the boot apply: '${await js(`document.querySelector('.health-row[data-row="oc"]')?.textContent ?? ''`)}'`);
  }
  const ocRowText = await js(`document.querySelector('.health-row[data-row="oc"]')?.textContent ?? ''`);
  if (!ocRowText.includes('Overclock Applied')) {
    fail(`M16: the OC status row reads '${ocRowText}' (expected 'Overclock Applied' - the boot-applied 230 W is non-stock)`);
  }
  const bootOutcome = await js(`window.arcPower.bootApplyOutcome()`);
  if (!bootOutcome || bootOutcome.ok !== true || !bootOutcome.detail.includes('Boot Apply Probe')) {
    fail(`M4N: the boot-apply outcome record does not carry the applied profile ("Profile 'Boot Apply Probe' applied"): '${JSON.stringify(bootOutcome)}'`);
  }
  step('boot-apply-outcome-row', `M16/M4N: the OC status health row is GREEN after the boot apply (reads '${ocRowText.trim()}'); the bootApplyOutcome record carries '${bootOutcome.detail}'`);

  // M4-D2 (§1): the shared close-to-tray REAL close probe - the LAST step.
  await runCloseToTrayProbe(win);

  console.log('\nUI VERIFY OK (boot-apply)\n' + steps.map((s) => '  ' + s).join('\n'));
  app.exit(0);
}

// ---------------------------------------------------------------------------
// M4O - boot-apply-EXT variant (RID_MOCK_BOOT_APPLY_EXT=1, run WITH
// RID_MOCK_STOCK_MODE=1 - the two BOOT knobs are NEVER combined)
// ---------------------------------------------------------------------------
//
// The session seed wrote ocOnBoot:true + activeProfileId 'boot-apply-probe'
// with the EXTENDED 315 W profile into the ISOLATED mock store, so the
// WINDOW-PATH automatic apply (which runs BEFORE createWindow) executed at
// boot against a STOCK-mode session - the exact report shape (stock
// mode selected + a profile using advanced values fails at boot apply with
// the "This value is beyond the standard Intel limit..." message). The M4O
// fix makes the profileApply path ignore the OC-mode gate (the mode gates
// ONLY the interactive flagless slider applies) - the profile applies
// against the driver's TRUE limits. This runner asserts:
//   (a) mock:boot-apply-log has EXACTLY ONE entry with applied:true (the
//       AUTOMATIC window-path apply recorded it - the seed is what makes
//       it run; hide/show never re-applies, so the exactly-one assert is
//       safe before the close probe);
//   (b) getCurrentSettings(0).powerLimitW === 315 - the post-apply DEVICE
//       state (the tuning slider would display the stock-snapped 252, so
//       the assertion is the device state, NOT the slider);
//   (c) the OC status health row is GREEN and reads the M16 stock-state
//       text ('Overclock Applied' - the boot-applied 315 W is non-stock);
//       the profile-name record is pinned via bootApplyOutcome() (the
//       M4N window-path bootApplyOutcome pattern).
// THE regression pin: the old code refused this exact seed with the mode
// message and the boot-apply log recorded applied:false.

/**
 * @param {import('electron').BrowserWindow} win
 * @param {import('./backend/mock-backend.js').MockBackend} backend
 * @param {import('./store/profile-store.js').ProfileStore} store
 */
export async function runBootApplyExtVerify(win, backend, store) {
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

  // The seed wrote waiverAccepted:true - the boot prompt is SKIPPED
  // entirely (the M4-D permanent-acceptance shape), exactly like the plain
  // boot-apply variant.
  if (!(await waitFor(win, `document.querySelectorAll('.health-card').length === 1`, 15000))) {
    fail(`M4O: the boot-apply-EXT session did not land the dashboard health card: page='${(await js(`(document.getElementById('page')?.textContent ?? '').slice(0, 200)`))}'`);
  }
  await sleep(600);
  if (await js(`!!document.querySelector('.modal')`)) {
    fail('M4O: the boot waiver prompt appeared in the boot-apply-EXT session (the seed wrote waiverAccepted:true - the boot prompt must be skipped)');
  }
  step('boot-apply-ext-waiver', 'boot-apply-EXT session: the seeded acceptance skips the boot prompt entirely');

  // (a) the automatic window-path apply recorded EXACTLY ONE entry.
  const bootLog = await js(`window.arcPower.mockBootApplyLog()`);
  if (!Array.isArray(bootLog) || bootLog.length !== 1) {
    fail(`M4O: the mock boot-apply log has ${Array.isArray(bootLog) ? bootLog.length : 'no'} entry (expected exactly ONE - the automatic window-path apply): ${JSON.stringify(bootLog)}`);
  }
  const entry = bootLog[0];
  if (entry.applied !== true || entry.profileId !== 'boot-apply-probe') {
    fail(`M4O: the boot-apply log entry is ${JSON.stringify(entry)} (expected { profileId: 'boot-apply-probe', applied: true } - the automatic apply of the EXTENDED probe profile; the old code recorded a mode refusal here)`);
  }
  step('boot-apply-ext-log', `mock:boot-apply-log records the automatic apply: ${JSON.stringify(entry)}`);

  // (b) the DEVICE state read-back: 315 W landed. The tuning slider would
  // snap to the stock max 252 - the device state is the assertion (the
  // profile's value applied against the driver's true limits).
  const state = await backend.getCurrentSettings(0);
  if (Math.abs(state.powerLimitW - 315) > 1e-6) {
    fail(`M4O: the boot-applied DEVICE state is ${state.powerLimitW} W (expected 315 W - the profile must apply against the driver's true limits, NOT the stock cap 252)`);
  }
  step('boot-apply-ext-device-state', `M4O: the post-apply DEVICE state is ${state.powerLimitW} W (315 - the stock-mode gate did not block the profile apply)`);

  // (c) the boot-apply OUTCOME reached the renderer - the dashboard OC
  // status row is GREEN and reads the M16 STOCK-STATE text: the boot-applied
  // 315 W differs from the 210 W stock default, so the row reads
  // 'Overclock Applied' (the last-apply profile NAME is no longer displayed
  // in the row - the record is pinned via window.arcPower.bootApplyOutcome()
  // below; the status-ok class sits on the inner .status-dot, not the row
  // element).
  await js(`location.hash = '#/dashboard'`);
  if (!(await waitFor(win, `!!document.querySelector('.health-row[data-row="oc"] .status-dot.status-ok')`, 8000))) {
    fail(`M4O: the OC status row is not green after the boot apply: '${await js(`document.querySelector('.health-row[data-row="oc"]')?.textContent ?? ''`)}'`);
  }
  const ocRowText = await js(`document.querySelector('.health-row[data-row="oc"]')?.textContent ?? ''`);
  if (!ocRowText.includes('Overclock Applied')) {
    fail(`M16: the OC status row reads '${ocRowText}' (expected 'Overclock Applied' - the boot-applied 315 W is non-stock)`);
  }
  const bootOutcome = await js(`window.arcPower.bootApplyOutcome()`);
  if (!bootOutcome || bootOutcome.ok !== true || !bootOutcome.detail.includes('Boot Apply Probe')) {
    fail(`M4O: the boot-apply outcome record does not carry the applied profile ("Profile 'Boot Apply Probe' applied"): '${JSON.stringify(bootOutcome)}'`);
  }
  step('boot-apply-ext-outcome-row', `M16/M4O: the OC status health row is GREEN after the boot apply (reads '${ocRowText.trim()}'); the bootApplyOutcome record carries '${bootOutcome.detail}'`);

  // M4-D2 (§1): the shared close-to-tray REAL close probe - the LAST step
  // (the exactly-one log assert above ran BEFORE it - hide/show never
  // re-applies).
  await runCloseToTrayProbe(win);

  console.log('\nUI VERIFY OK (boot-apply-ext)\n' + steps.map((s) => '  ' + s).join('\n'));
  app.exit(0);
}

// ---------------------------------------------------------------------------
// M16-F1 (D2) - tray-apply variant (RID_MOCK_TRAY_APPLY=1)
// ---------------------------------------------------------------------------
//
// The session seed wrote activeProfileId 'boot-apply-probe' + the probe
// profile itself (the in-range 230 W values) WITHOUT ocOnBoot - the boot
// NEVER auto-applies, and the tray menu's "Apply active profile" item is
// enabled. The seed ALSO writes waiverAccepted:true (the tray apply must
// pass the waiver gate), so the boot prompt is SKIPPED entirely (the
// M4-D permanent-acceptance shape). This runner asserts the D2 fix end to
// end:
//   (a) the boot landed at STOCK: the dashboard OC status row reads
//       'No Overclock Applied' (nothing applied yet - the tray variant
//       must NOT boot an auto-apply);
//   (b) the recorded tray "Apply active profile" click handler runs the
//       REAL main-side apply (applyProfile) - the tray probe recorded it
//       from the menu template;
//   (c) the renderer PUSH flipped the OC row to 'Overclock Applied' IN
//       PLACE (main sent device:state-updated with the post-apply
//       read-back - the renderer's store.state slot refreshed, no
//       navigation) - the D2 regression: the row used to keep the stale
//       pre-apply 'No Overclock Applied' for the rest of the session;
//   (d) the DRIVER really runs the applied values (the mock read-back
//       agrees: 230 W).
//
// Modeled on runBootApplyVerify (same shared store/backend, same
// close-to-tray ending) - a separate runner because the tray-apply seed's
// active profile would trip the DEFAULT flow's no-profile pins.

/**
 * @param {import('electron').BrowserWindow} win
 * @param {import('./backend/mock-backend.js').MockBackend} backend
 * @param {import('./store/profile-store.js').ProfileStore} store
 * @param {() => { builds: number, toggleHandler: null | (() => void), applyHandler: null | (() => void) }} getTrayProbe
 */
export async function runTrayApplyVerify(win, backend, store, getTrayProbe) {
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
  const ocRowExpr = `document.querySelector('.health-card .health-row[data-row="oc"] .health-row-detail')?.textContent ?? ''`;

  // The seed wrote waiverAccepted:true - the boot prompt is SKIPPED
  // entirely (the M4-D permanent-acceptance shape). Assert the boot
  // sequence landed (the dashboard health card renders after caps arrive)
  // and no modal ever appeared.
  if (!(await waitFor(win, `document.querySelectorAll('.health-card').length === 1`, 15000))) {
    fail(`M16-F1: the tray-apply session did not land the dashboard health card: page='${(await js(`(document.getElementById('page')?.textContent ?? '').slice(0, 200)`))}'`);
  }
  await sleep(600);
  if (await js(`!!document.querySelector('.modal')`)) {
    fail('M16-F1: the boot waiver prompt appeared in the tray-apply session (the seed wrote waiverAccepted:true - the boot prompt must be skipped)');
  }
  step('tray-apply-waiver', 'tray-apply session: the seed writes an ACCEPTED store (the tray "Apply active profile" must pass the waiver gate) - boot prompt SKIPPED entirely');

  // (a) booted at STOCK: the row reads 'No Overclock Applied' - the tray
  // variant never auto-applies at boot (ocOnBoot is never seeded for it).
  const ocBefore = (await js(ocRowExpr)).trim();
  if (ocBefore !== 'No Overclock Applied') {
    fail(`M16-F1: the OC status row must read 'No Overclock Applied' BEFORE the tray apply (got '${ocBefore}' - the tray variant must boot at stock; ocOnBoot is never seeded for it)`);
  }
  step('tray-apply-before', `M16-F1: the OC status row reads '${ocBefore}' before the tray apply (the boot never auto-applies)`);

  // (b) the recorded tray click handler exists (the menu template wired it
  // to trayApplyActiveProfile - the D2 wiring) and runs the REAL apply.
  const probe = getTrayProbe();
  if (typeof probe.applyHandler !== 'function') {
    fail('M16-F1: the tray probe did not record the "Apply active profile" click handler');
  }
  probe.applyHandler();

  // (c) THE D2 REGRESSION: the pushed post-apply read-back flipped the row
  // IN PLACE (device:state-updated -> store.state -> the dashboard
  // re-render sig). The old code never pushed - the row stayed stale
  // 'No Overclock Applied' for the rest of the session.
  if (!(await waitFor(win, `(${ocRowExpr}).trim() === 'Overclock Applied'`, 8000))) {
    fail(`M16-F1: the OC status row did not flip to 'Overclock Applied' after the tray apply (still '${(await js(ocRowExpr)).trim()}' - the pushed post-apply read-back never refreshed the store state)`);
  }
  step('m16-tray-apply-row', `M16-F1: tray apply -> the dashboard OC status row flipped '${ocBefore}' -> 'Overclock Applied' IN PLACE (main pushed the post-apply read-back via device:state-updated)`);

  // (d) the DRIVER really runs the applied values - the mock read-back
  // agrees with the probe profile (230 W, 100 MHz) - the row flipped for
  // the RIGHT reason, not a cosmetic store patch.
  const driver = await backend.getCurrentSettings(0);
  if (Math.abs(driver.powerLimitW - 230) > 1e-6 || driver.gpuFreqOffsetMhz !== 100) {
    fail(`M16-F1: the driver read-back after the tray apply is PL=${driver.powerLimitW} W / freq=${driver.gpuFreqOffsetMhz} MHz (expected the probe profile's 230 W / 100 MHz - the apply must really land)`);
  }
  step('tray-apply-driver', `M16-F1: the driver read-back after the tray apply is ${driver.powerLimitW} W / ${driver.gpuFreqOffsetMhz} MHz (the probe profile really landed)`);

  // M4-D2 (§1): the shared close-to-tray REAL close probe - the LAST step.
  await runCloseToTrayProbe(win);

  console.log('\nUI VERIFY OK (tray-apply)\n' + steps.map((s) => '  ' + s).join('\n'));
  app.exit(0);
}

// ---------------------------------------------------------------------------
// M5 - the software-overlay variant (RID_MOCK_OVERLAY=1, three matrix
// configs: 'overlay' alone, 'overlay+fps' with RID_MOCK_FPS=1, and
// 'overlay+fps+api' with RID_MOCK_API=1 - the M13 standalone API row).
// ---------------------------------------------------------------------------
//
// The session seed (main.js) wrote overlayEnabled:true + the default
// letter/position/scale (+ the M7b background box off/black/0.5) into the
// ISOLATED mock store, so the overlay window (REAL in this variant, like
// the main window) boots SHOWN. The hotkey is the COUNTING probe (never a
// real globalShortcut registration). This runner asserts:
//   (a) 'overlay:get-state' -> exists + visible (the seeded session);
//   (b) the overlay DOM lines - ONLY the STABLE fields pinned exactly
//       ('CPU 42%', '4.3 GHz', '61°C'|'62°C', '125.5 W'|'-' - the M13 CPU
//       watt field with the RID_MOCK_NO_POWER_METER degrade, 'GPU 42%',
//       '0.652 V', '38.8 W', '1030 RPM' + the M14 'RAM 12.4 GB' + 'VRAM 3.0
//       GB' rows); the climbing clock/temp are pattern-matched (/GPU 42%
//       \d+ MHz  \d+°C  0\.652 V  38\.8 W  1030 RPM/ - M16: the GPU line is
//       Util / Core clock / Temp / Voltage / Power / Fan - the mem-clock
//       LEFT the row (it leads the VRAM row now) and the voltage rides
//       INSIDE the row between the temp and the power fields; the
//       standalone #overlay-voltage div does NOT exist); the FPS row pins
//       the FULL line -
//       'FPS -  AVG -  1% Low -  0.1% Low -  99% FPS -' unless
//       RID_MOCK_FPS=1 -> 'FPS 60  AVG 58  1% Low 52  0.1% Low 42
//       99% FPS 58' (M7a/M12: the percentile + AVG stats ride the FPS
//       row); M13: the standalone API row (#overlay-api between the VRAM
//       row and the frametime strip) reads 'DX12' under RID_MOCK_API=1
//       and stays EMPTY without the knob (the M10a vanish rule - never
//       '-'); the mock fixture at main.js feeds the 'dx12';
//   (c) the frametime canvas has DRAWN content under RID_MOCK_FPS=1 (the
//       16.7 ms passthrough series);
//   (d) M7b (fix 5): the SHORTCUT semantics - 'overlay:toggle' (the
//       hotkey's channel) flips the SESSION visibility only while the
//       master overlayEnabled is ON; the persisted master NEVER flips
//       from the hotkey;
//   (e) the hotkey probe registered 'Control+O' + the getState
//       hotkeyRegistered flag reads true;
//   (f) a position patch via profiles-settings-save repositions the window
//       (the corner asserted via get-state bounds) + a scale patch resizes
//       it (bounds width x the scale - the geometry application);
//   (f2b) M7b (fix 5): the General toggle is the MASTER's only writer -
//       off -> persisted false + hidden (the shortcut does NOTHING while
//       off), on -> persisted true + shown (the shortcut flips the
//       visibility only, never the persisted value);
//   (f3/f3b/f3c/f3d/f3e/f3f/f3g) the stat tickbox round trips (gpu-fan, the
//       M7a 1% Low / 99% FPS pair, the M12 AVG / 0.1% Low pair, the M13
//       Graphics-API row, the M12 Memory row + the gpu-vram VRAM row, the
//       frametime strip, the M16 gpu-voltage GPU-row field + the gpu-vram-temp
//       VRAM-row tail);
//   (f5) the color swatch round trip (overlayColor + the CSSOM var + the
//       canvas stroke);
//   (f6) M7b (fix 4): the background box round trip - the toggle, the
//       color swatch + the opacity slider through profiles-settings-save,
//       the backdrop .visible class + the --overlay-bg-color /
//       --overlay-bg-opacity CSS vars re-rendering on every push;
//   (g) the mid-run register-failure honesty: the probe fakes a failure
//       (settable mid-run, not a boot knob), a letter save via the Settings
//       card re-registers through the probe, and the honest hotkey note
//       appears after the card's every-render get-state re-query. Restored
//       at the end (letter O, failRegister false, geometry + bg defaults)
//       so the next overlay run boots deterministically.

/**
 * @param {import('electron').BrowserWindow} win the MAIN window
 * @param {{ getWindow: () => import('electron').BrowserWindow | null, getState: () => object, toggle: () => Promise<void>, setHotkeyRegistered: (flag: boolean) => void }} overlayHandle
 *   the overlay handle created by main.js under RID_MOCK_OVERLAY=1
 * @param {import('./store/profile-store.js').ProfileStore} store the session store
 * @param {{ registrations: string[], failRegister: boolean }} hotkeyProbe
 *   the injected counting hotkey probe (never a real registration)
 * @param {() => number} [getFpsPolls] dev probe: fps-poll invocations (the
 *   M17f fast-rate pin - the overlay's own fps loop counts through it)
 */
export async function runOverlayVerify(win, overlayHandle, store, hotkeyProbe, getFpsPolls = () => 0) {
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
  const overlayWin = overlayHandle ? overlayHandle.getWindow() : null;
  if (!overlayWin || overlayWin.isDestroyed()) {
    fail('M5: the overlay window does not exist under RID_MOCK_OVERLAY=1 (main.js must create it under the knob)');
  }
  const ojs = (code) => overlayWin.webContents.executeJavaScript(code);
  const mockFps = process.env.RID_MOCK_FPS === '1';
  // M13: RID_MOCK_API=1 - the mock fps sample carries the 'dx12' fixture
  // (the knobs travel together; without RID_MOCK_FPS the poll returns null
  // and the API row never fills).
  const mockApi = process.env.RID_MOCK_API === '1';
  // M13: RID_MOCK_NO_POWER_METER=1 - the mock's cpuPowerW stays null (the
  // honest no-metering shape - the CPU-row watt field renders '-').
  const noPowerMeter = process.env.RID_MOCK_NO_POWER_METER === '1';

  // (a) the seeded session: exists + visible.
  const s0 = await js(`window.arcPower.overlayGetState()`);
  if (!s0.exists) fail('M5: overlay:get-state reports exists:false in the overlay variant');
  if (!s0.visible) fail('M5: the seeded overlayEnabled:true session must boot with the overlay SHOWN (get-state visible:false)');
  if (s0.hotkeyRegistered !== true) fail(`M5: the boot hotkey registration did not land (hotkeyRegistered ${s0.hotkeyRegistered}, probe ${JSON.stringify(hotkeyProbe.registrations)})`);
  step('m5-get-state', `overlay:get-state -> exists + visible (bounds ${JSON.stringify(s0.bounds)}, position '${s0.position}', scale ${s0.scale})`);

  // (b) the overlay DOM lines. The mock telemetry: util 42, cpuFreq 4300
  // ('4.3 GHz'), cpuTemp 61|62 alternating, memClock 2187, vram 2971324416
  // ('3.0 GB'), power 38.8 ('38.8 W'), fan 1030 ('1030 RPM'); the clock
  // climbs 600+tick*100 and the GPU temp climbs 36+tick%30 - those two are
  // pattern-matched, never exact-pinned (M1).
  if (!(await waitFor(overlayWin, `(document.getElementById('overlay-cpu')?.textContent ?? '').includes('CPU 42%')`, 15000))) {
    fail(`M5: the overlay CPU line lacks 'CPU 42%': '${await ojs(`document.getElementById('overlay-cpu')?.textContent ?? ''`)}'`);
  }
  if (!(await waitFor(overlayWin, `(document.getElementById('overlay-cpu')?.textContent ?? '').includes('4.3 GHz')`, 5000))) {
    fail(`M5: the overlay CPU line lacks '4.3 GHz': '${await ojs(`document.getElementById('overlay-cpu')?.textContent ?? ''`)}'`);
  }
  if (!(await waitFor(overlayWin, `/61°C|62°C/.test(document.getElementById('overlay-cpu')?.textContent ?? '')`, 5000))) {
    fail(`M5: the overlay CPU line lacks the 61°C|62°C temp: '${await ojs(`document.getElementById('overlay-cpu')?.textContent ?? ''`)}'`);
  }
  // M13: the CPU-row watt field - the mock PowerMeter fixture 125.5 W
  // (M4-H, the sys-stats fixture) with the toFixed(1) format; the
  // RID_MOCK_NO_POWER_METER=1 knob makes it the honest '-' degrade (the
  // temp alternates 61|62 so the row is matched by its tail field).
  const wantCpuWatt = noPowerMeter ? '-' : '125.5 W';
  if (!(await waitFor(overlayWin, `(document.getElementById('overlay-cpu')?.textContent ?? '').trim().endsWith('${wantCpuWatt}')`, 10000))) {
    fail(`M13: the overlay CPU line lacks the watt field '${wantCpuWatt}': '${await ojs(`document.getElementById('overlay-cpu')?.textContent ?? ''`)}'`);
  }
  // M16 (amended 2026-08-11): the MEM-CLOCK field LEFT the GPU row (it
  // leads the VRAM row now) and the GPU VOLTAGE is a FIELD INSIDE the GPU
  // row (between the temp and the power fields) - the standalone Voltage
  // row is GONE. The GPU line is Util / Core clock / Temp / Voltage /
  // Power / Fan: 'GPU 42%  <clock> MHz  <temp>°C  0.652 V  38.8 W  1030
  // RPM' (the mock's gpuVoltageV 0.652 - volts keep 3 decimals).
  if (!(await waitFor(overlayWin, `/GPU 42%  \\d+ MHz  \\d+°C  0\\.652 V  38\\.8 W  1030 RPM/.test(document.getElementById('overlay-gpu')?.textContent ?? '')`, 15000))) {
    fail(`M16: the overlay GPU line does not match the pinned pattern (Util / Core clock / Temp / Voltage 0.652 V / Power / Fan): '${await ojs(`document.getElementById('overlay-gpu')?.textContent ?? ''`)}'`);
  }
  // M16: the standalone Voltage row is REMOVED - the #overlay-voltage div
  // must not exist (the voltage is a GPU-row field now).
  if (await ojs(`!!document.getElementById('overlay-voltage')`)) {
    fail('M16: the standalone #overlay-voltage row still exists (the GPU voltage must be a field INSIDE the GPU row - the row div was removed)');
  }
  // M7a/M12: the FPS row carries the percentile + AVG stats - the full
  // pinned line: 'FPS 60  AVG 58  1% Low 52  0.1% Low 42  99% FPS 58'
  // under RID_MOCK_FPS=1 (the mock fixture 58/52/42/58 at main.js) /
  // 'FPS -  AVG -  1% Low -  0.1% Low -  99% FPS -' without it (the
  // 0.1% Low honest '-' degrade - the 300-frame floor).
  // M13: the api field LEFT this row - the fpsLine NEVER carries a badge
  // (the standalone API row pins below cover the mockApi shape).
  const fpsPin = mockFps
    ? 'FPS 60  AVG 58  1% Low 52  0.1% Low 42  99% FPS 58'
    : 'FPS -  AVG -  1% Low -  0.1% Low -  99% FPS -';
  if (!(await waitFor(overlayWin, `(document.getElementById('overlay-fps')?.textContent ?? '').trim() === '${fpsPin}'`, 10000))) {
    fail(`M5: the overlay FPS line is '${await ojs(`document.getElementById('overlay-fps')?.textContent ?? ''`)}' (expected '${fpsPin}'${mockFps ? '' : ' - the fps poll is unavailable without RID_MOCK_FPS'})`);
  }
  // M13: the standalone API row - the api field LEFT the FPS row and
  // renders here. Under RID_MOCK_API=1 the row reads 'DX12'; without the
  // knob (or when the api is null/unknown) the row stays EMPTY - never a
  // '-' (the M10a vanish rule).
  const apiPin = mockApi ? 'DX12' : '';
  if (!(await waitFor(overlayWin, `(document.getElementById('overlay-api')?.textContent ?? '').trim() === '${apiPin}'`, 10000))) {
    fail(`M13: the overlay API row is '${await ojs(`document.getElementById('overlay-api')?.textContent ?? ''`)}' (expected '${apiPin}'${mockApi ? '' : ' - no api detected, the row stays empty'})`);
  }
  // M13: the row-ORDER pin - the api row sits BETWEEN the VRAM row and the
  // frametime strip (the user's placement: above the frametime graph).
  const apiOrder = await ojs(`(() => {
    const root = document.getElementById('overlay-root');
    if (!root) return 'missing-root';
    const html = root.innerHTML;
    const iVram = html.indexOf('id="overlay-vram"');
    const iApi = html.indexOf('id="overlay-api"');
    const iCanvas = html.indexOf('id="overlay-frametime"');
    return iVram < iApi && iApi < iCanvas ? 'ok' : 'wrong';
  })()`);
  if (apiOrder !== 'ok') {
    fail(`M13: the api row is not between the VRAM row and the frametime strip (DOM order '${apiOrder}')`);
  }
  // M14: the Memory row - the sysStats fixture's memoryUsedBytes
  // 12400000000 (12.4 GB - decimal, the fixture-wins composition; M13:
  // the row label reads 'RAM'). M16: the VRAM row now carries
  // 'MemClock;VRAM;VramTEMP' - the mock's memClockMhz 2187, gpuMemUsedBytes
  // 2971324416 -> '3.0 GB' and vramTempC = tempCBase + 8 + (tick % 10)
  // (the 44|..|53°C ramp - pattern-matched: /2187 MHz  3\.0 GB  \d+°C/).
  if (!(await waitFor(overlayWin, `(document.getElementById('overlay-memory')?.textContent ?? '').trim() === 'RAM 12.4 GB'`, 10000))) {
    fail(`M14: the overlay Memory row is '${await ojs(`document.getElementById('overlay-memory')?.textContent ?? ''`)}' (expected 'RAM 12.4 GB' - the sysStats fixture's memoryUsedBytes)`);
  }
  // M16: the VRAM row carries 'MemClock;VRAM;VramTEMP' - the mock's
  // memClockMhz 2187, gpuMemUsedBytes 2971324416 ('3.0 GB') and the
  // vramTempC ramp (tempCBase + 8 + tick%10 -> 44..53°C - pattern-matched).
  if (!(await waitFor(overlayWin, `/VRAM 2187 MHz  3\\.0 GB  \\d+°C/.test(document.getElementById('overlay-vram')?.textContent ?? '')`, 10000))) {
    fail(`M16: the overlay VRAM row is '${await ojs(`document.getElementById('overlay-vram')?.textContent ?? ''`)}' (expected 'VRAM 2187 MHz  3.0 GB  <temp>°C' - MemClock;VRAM;VramTEMP)`);
  }
  step('m5-lines', `overlay DOM: cpu '${await ojs(`document.getElementById('overlay-cpu')?.textContent ?? ''`)}'; memory '${await ojs(`document.getElementById('overlay-memory')?.textContent ?? ''`)}'; gpu matches the pinned pattern (Util / Core clock / Temp / Voltage 0.652 V / Power / Fan - the voltage rides INSIDE the GPU row, no #overlay-voltage row); vram '${await ojs(`document.getElementById('overlay-vram')?.textContent ?? ''`)}' (MemClock;VRAM;VramTEMP); api '${apiPin}' (row order: vram -> api -> frametime strip); fps '${fpsPin}'`);
  // M6: the stock color applies at boot (the seeded white) - the
  // --overlay-color CSS var drives the line color (the renderer applies
  // the pushed hex via CSSOM; the var fallback is the stock white).
  if (!(await waitFor(overlayWin, `document.documentElement.style.getPropertyValue('--overlay-color') === '#ffffff'`, 5000))) {
    fail(`M6: the boot overlay color var is not the stock white: '${await ojs(`document.documentElement.style.getPropertyValue('--overlay-color')`)}'`);
  }

  // (c) the frametime canvas has drawn content under RID_MOCK_FPS=1 (the
  // 16.7 ms passthrough series fed the polyline - non-transparent pixels on
  // the otherwise transparent canvas).
  if (mockFps) {
    const drawn = await waitFor(overlayWin, `(() => {
      const c = document.getElementById('overlay-frametime');
      if (!c || c.width === 0 || c.height === 0) return false;
      const ctx = c.getContext('2d');
      if (!ctx) return false;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) n++; }
      return n > 20;
    })()`, 10000);
    if (!drawn) {
      const diag = await ojs(`(() => {
        const c = document.getElementById('overlay-frametime');
        let pixels = null;
        if (c && c.width > 0) {
          try {
            const ctx = c.getContext('2d');
            const d = ctx.getImageData(0, 0, c.width, c.height).data;
            let n = 0;
            for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) n++; }
            pixels = n;
          } catch (e) { pixels = 'ctx:' + String(e); }
        }
        return JSON.stringify({
          canvas: c ? { w: c.width, h: c.height, cssW: c.getBoundingClientRect().width, cssH: c.getBoundingClientRect().height } : null,
          htmlFs: document.documentElement.style.fontSize,
          fps: document.getElementById('overlay-fps')?.textContent ?? null,
          pixels,
        });
      })()`);
      fail(`M5: the frametime canvas has no drawn content under RID_MOCK_FPS=1 (the passthrough 16.7 ms series must paint the polyline): ${diag}`);
    }
    step('m5-frametime-canvas', 'the frametime canvas drew the polyline (non-transparent pixels > 20)');
    // M6-amd2: the frametime VALUE line below the strip reads the
    // passthrough (max 2 decimals, never padded - the 16.7 ms shape).
    if (!(await waitFor(overlayWin, `(document.getElementById('overlay-frametime-value')?.textContent ?? '').trim() === '16.7 ms'`, 5000))) {
      fail(`M6-amd2: the frametime value line reads '${await ojs(`document.getElementById('overlay-frametime-value')?.textContent ?? ''`)}' (expected '16.7 ms' - the passthrough)`);
    }
    step('m6-frametime-value', `the frametime value line reads '16.7 ms' (the passthrough, never padded)`);
  } else {
    step('m5-frametime-canvas', 'frametime canvas pin SKIPPED (RID_MOCK_FPS not set - no series, nothing drawn)');
    // M6-amd2: with no fps poll data the value line honestly shows '-'
    // (the element exists; nothing to derive from).
    if (!(await waitFor(overlayWin, `(document.getElementById('overlay-frametime-value')?.textContent ?? '').trim() === '-'`, 5000))) {
      fail(`M6-amd2: the frametime value line reads '${await ojs(`document.getElementById('overlay-frametime-value')?.textContent ?? ''`)}' (expected the honest '-')`);
    }
    step('m6-frametime-value', "the frametime value line honestly reads '-' (no fps poll data)");
  }

  // (d) M7b (fix 5): the toggle and the shortcut are INDEPENDENT now.
  // 'overlay:toggle' (the hotkey's channel) is the SHORTCUT: with the
  // master overlayEnabled ON (the seeded session), pressing it flips the
  // SESSION visibility only - the persisted overlayEnabled NEVER flips
  // (the Overlay-page General toggle is its only writer; a reboot shows
  // the overlay again when it is enabled).
  const s1 = await js(`window.arcPower.overlayToggle()`);
  if (s1.visible) fail('M5: overlay:toggle did not HIDE the visible overlay');
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayEnabled === true)`, 5000))) {
    fail('M7b: the shortcut press must NOT write overlayEnabled (still true - the hotkey never persists)');
  }
  const s2 = await js(`window.arcPower.overlayToggle()`);
  if (!s2.visible) fail('M5: overlay:toggle did not SHOW the overlay again');
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayEnabled === true)`, 5000))) {
    fail('M7b: the second shortcut press must NOT write overlayEnabled either (still true)');
  }
  step('m5-toggle', 'M7b: the shortcut (overlay:toggle) flipped visible -> hidden -> visible while the persisted overlayEnabled stayed true - the hotkey NEVER writes the master');

  // (e) the hotkey probe registered 'Control+O' (the boot registration -
  // never a real globalShortcut) + the live hotkeyRegistered flag reads
  // true.
  if (!hotkeyProbe.registrations.includes('Control+O')) {
    fail(`M5: the hotkey probe never registered 'Control+O' (got ${JSON.stringify(hotkeyProbe.registrations)})`);
  }
  const s3 = await js(`window.arcPower.overlayGetState()`);
  if (s3.hotkeyRegistered !== true) fail(`M5: hotkeyRegistered reads ${s3.hotkeyRegistered} (expected true after a successful probe registration)`);
  step('m5-hotkey', `hotkey probe registered ${JSON.stringify(hotkeyProbe.registrations)} (no real globalShortcut); hotkeyRegistered true`);

  // (f) a position patch via profiles-settings-save repositions the window
  // (the corner asserted via get-state bounds) + a scale patch resizes it
  // (the geometry application; the push + the resize applied together).
  const display = screen.getPrimaryDisplay().bounds;
  await js(`window.arcPower.profilesSettingsSave({ overlayPosition: 'bottom-right' })`);
  await sleep(500);
  const ps = await js(`window.arcPower.overlayGetState()`);
  const right = Math.abs((ps.bounds.x + ps.bounds.width) - (display.x + display.width - 8));
  const bottom = Math.abs((ps.bounds.y + ps.bounds.height) - (display.y + display.height - 8));
  if (right > 2 || bottom > 2) {
    fail(`M5: the bottom-right patch did not reposition the overlay (bounds ${JSON.stringify(ps.bounds)}, display ${JSON.stringify(display)} - expected the bottom-right corner with the 8px margin)`);
  }
  await js(`window.arcPower.profilesSettingsSave({ overlayScale: 2 })`);
  await sleep(500);
  const scaled = await js(`window.arcPower.overlayGetState()`);
  if (Math.abs(scaled.bounds.width - 460 * 2) > 2 || Math.abs(scaled.bounds.height - 170 * 2) > 2) {
    fail(`M16: the scale 2 patch did not resize the overlay (bounds ${JSON.stringify(scaled.bounds)} - expected ~920x340 - the base height is back to 170: the Voltage row is a GPU-row FIELD now, not a standalone line)`);
  }
  step('m5-geometry', `position patch -> bottom-right corner (bounds ${JSON.stringify(ps.bounds)} vs display ${JSON.stringify(display)}); scale patch -> ${scaled.bounds.width}x${scaled.bounds.height}`);

  // (f2) M9: the shrunk Settings card's "Overlay settings" button navigates
  // to #/monitoring with the OVERLAY view active (the Overlay Settings
  // content moved into the Monitoring page in M9 - the old #/overlay page
  // is gone; the old hash still redirects). M6-amd3: the card is
  // BUTTON-ONLY now - the enable toggle moved to the overlay view's
  // General card (the .settings-checkbox[data-setting="overlayEnabled"]
  // class + dataset moved with it).
  await js(`location.hash = '#/settings'`);
  if (!(await waitFor(win, `!!document.querySelector('.overlay-settings-button')`, 5000))) {
    fail('M6: the Settings page has no "Overlay settings" button');
  }
  if (await js(`!!document.querySelector('.settings-checkbox[data-setting="overlayEnabled"]')`)) {
    fail('M6-amd3: the Settings Overlay card still has the enable toggle (it moved to the overlay view General card)');
  }
  await js(`(() => { const b = document.querySelector('.overlay-settings-button'); b.click(); })()`);
  if (!(await waitFor(win, `location.hash === '#/monitoring'`, 5000))) {
    fail('M9: the Settings "Overlay settings" button did not navigate to #/monitoring');
  }
  if (!(await waitFor(win, `(document.getElementById('page')?.textContent ?? '').includes('Overlay Settings')`, 5000))) {
    fail('M9: the Monitoring page did not render the Overlay view (no "Overlay Settings" heading)');
  }
  // M9: the view pill marks the Overlay view active (the Settings-button
  // path requested the view before navigating).
  if (!(await waitFor(win, `(() => {
    const b = Array.from(document.querySelectorAll('.mon-view-btn')).find((x) => (x.textContent ?? '').trim() === 'Overlay');
    return !!b && b.classList.contains('active');
  })()`, 5000))) {
    fail('M9: the Monitoring view pill does not mark the Overlay view active after the Settings-button navigation');
  }
  step('m9-settings-button', 'Settings "Overlay settings" button navigated to #/monitoring with the Overlay view active (the "Overlay Settings" heading renders in the Monitoring page; the Settings card is button-only)');

  // (f2-m9) M9: the Position setting moved INTO the Appearance card - the
  // standalone Position card is GONE, the .settings-position-select now
  // lives in the Appearance card (the same row pattern as the Size row).
  if (await js(`!!document.querySelector('.overlay-position-card')`)) {
    fail('M9: the standalone Position card is still rendered (the position moved into the Appearance card)');
  }
  if (!(await js(`!!document.querySelector('.overlay-appearance-card .settings-position-select')`))) {
    fail('M9: the Appearance card has no .settings-position-select (the position row must live there)');
  }
  const positionRow = await js(`(() => {
    const row = Array.from(document.querySelectorAll('.overlay-appearance-card .settings-row')).find((r) => r.querySelector('.settings-position-select'));
    return row ? (row.querySelector('.settings-row-label')?.textContent ?? '').trim() : '';
  })()`);
  if (positionRow !== 'Position') fail(`M9: the Appearance position row label is '${positionRow}' (expected 'Position')`);
  step('m9-position-in-appearance', 'M9: the Position setting lives in the Appearance card (the standalone Position card is gone; the .settings-position-select row reads "Position")');

  // (f2b) M6-amd3: the enable toggle MOVED to the General card at the top
  // of the overlay view - clicking it flips the persisted overlayEnabled
  // AND the overlay window (the same read-modify-write the Settings toggle
  // used). M7b (fix 5): this toggle is the MASTER's only writer - the
  // shortcut gate pin below proves the independence both ways.
  if (!(await waitFor(win, `!!document.querySelector('.settings-checkbox[data-setting="overlayEnabled"]')`, 5000))) {
    fail('M6-amd3: the overlay view General card has no overlayEnabled toggle');
  }
  await js(`(() => { const b = document.querySelector('.settings-checkbox[data-setting="overlayEnabled"]'); b.click(); })()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayEnabled === false)`, 5000))) {
    fail('M6-amd3: the General-card toggle did not persist overlayEnabled=false');
  }
  if (!(await waitFor(win, `window.arcPower.overlayGetState().then((s) => s.visible === false)`, 5000))) {
    fail('M6-amd3: the General-card toggle off did not HIDE the overlay window');
  }
  // M7b (fix 5, pin a): with the master OFF the shortcut does NOTHING -
  // the window stays hidden AND overlayEnabled stays false in the store
  // (the pre-fix behavior showed the overlay + flipped the persisted
  // state - the reported "toggle does not work" bug).
  const sOff = await js(`window.arcPower.overlayToggle()`);
  if (sOff.visible) {
    fail('M7b: the shortcut must NOT show the overlay while the master overlayEnabled is OFF');
  }
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayEnabled === false)`, 5000))) {
    fail('M7b: the shortcut press while the master is OFF must NOT write overlayEnabled (still false)');
  }
  await js(`(() => { const b = document.querySelector('.settings-checkbox[data-setting="overlayEnabled"]'); b.click(); })()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayEnabled === true)`, 5000))) {
    fail('M6-amd3: the General-card toggle did not persist overlayEnabled=true');
  }
  if (!(await waitFor(win, `window.arcPower.overlayGetState().then((s) => s.visible === true)`, 5000))) {
    fail('M6-amd3: the General-card toggle on did not SHOW the overlay window');
  }
  // M7b (fix 5, pin b): the master is ON again - the shortcut flips the
  // visibility (hidden -> shown) while the persisted overlayEnabled never
  // flips (the master stays true).
  const sOnHide = await js(`window.arcPower.overlayToggle()`);
  if (sOnHide.visible) fail('M7b: the shortcut did not HIDE the overlay with the master ON');
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayEnabled === true)`, 5000))) {
    fail('M7b: the shortcut must NOT write overlayEnabled with the master ON (still true)');
  }
  const sOnShow = await js(`window.arcPower.overlayToggle()`);
  if (!sOnShow.visible) fail('M7b: the shortcut did not SHOW the overlay again with the master ON');
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayEnabled === true)`, 5000))) {
    fail('M7b: the second shortcut press with the master ON must NOT write overlayEnabled either');
  }
  step('m6-general-toggle', 'the overlay view General toggle round trip: off -> persisted false + overlay hidden (the shortcut does NOTHING while the master is off); on -> persisted true + overlay shown (the shortcut flips the visibility only - the master never flips from the hotkey)');

  // (m17b-chipnames) M17b (2c): the chip-name row labels - the General
  // card's second checkbox round-trips like the master: ON -> the overlay
  // rows derive their labels from the BOOT NAMES FETCH (api.sysinfo() -
  // the mock fixture 'Intel(R) Arc(TM) A770 Graphics' -> 'A770', the CPU
  // 'Intel(R) Core(TM) i7-14700K' -> 'i7 14700K') with UNCHANGED field
  // order; OFF -> the stock 'CPU '/'GPU ' prefixes return (byte-identical).
  await js(`(() => { const b = document.querySelector('.settings-checkbox[data-setting="overlayChipNames"]'); if (b) b.click(); })()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayChipNames === true)`, 5000))) {
    fail('M17b: toggling the chip-names checkbox did not persist overlayChipNames=true');
  }
  if (!(await waitFor(overlayWin, `/^A770 42%  \\d+ MHz  \\d+°C  0\\.652 V  38\\.8 W  1030 RPM/.test(document.getElementById('overlay-gpu')?.textContent ?? '')`, 10000))) {
    fail(`M17b: the overlay GPU row label is not the mock-derived 'A770': '${await ojs(`document.getElementById('overlay-gpu')?.textContent ?? ''`)}' (expected 'A770 42%  <clock> MHz  <temp>°C  0.652 V  38.8 W  1030 RPM' - the field order unchanged)`);
  }
  if (!(await waitFor(overlayWin, `/^i7 14700K 42%  4\\.3 GHz/.test(document.getElementById('overlay-cpu')?.textContent ?? '')`, 10000))) {
    fail(`M17b: the overlay CPU row label is not the mock-derived 'i7 14700K': '${await ojs(`document.getElementById('overlay-cpu')?.textContent ?? ''`)}' (expected 'i7 14700K 42%  4.3 GHz ...' - the field order unchanged)`);
  }
  if (!(await waitFor(overlayWin, `(document.getElementById('overlay-gpu')?.textContent ?? '').includes('GPU ') === false && (document.getElementById('overlay-cpu')?.textContent ?? '').includes('CPU ') === false`, 5000))) {
    fail('M17b: the chip labels must REPLACE the stock prefixes (no doubling)');
  }
  step('m17b-chipnames-on', `the chip-names toggle ON: the overlay rows read 'A770 ...' + 'i7 14700K ...' (the boot names fetch labels) with the field order unchanged (${await ojs(`document.getElementById('overlay-gpu')?.textContent ?? ''`)} / ${await ojs(`document.getElementById('overlay-cpu')?.textContent ?? ''`)})`);
  await js(`(() => { const b = document.querySelector('.settings-checkbox[data-setting="overlayChipNames"]'); if (b) b.click(); })()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayChipNames === false)`, 5000))) {
    fail('M17b: re-toggling the chip-names checkbox did not persist overlayChipNames=false');
  }
  if (!(await waitFor(overlayWin, `/^GPU 42%  \\d+ MHz  \\d+°C  0\\.652 V  38\\.8 W  1030 RPM/.test(document.getElementById('overlay-gpu')?.textContent ?? '')`, 10000))) {
    fail(`M17b: re-toggling did not restore the stock 'GPU ' prefix: '${await ojs(`document.getElementById('overlay-gpu')?.textContent ?? ''`)}'`);
  }
  if (!(await waitFor(overlayWin, `/^CPU 42%  4\\.3 GHz/.test(document.getElementById('overlay-cpu')?.textContent ?? '')`, 10000))) {
    fail(`M17b: re-toggling did not restore the stock 'CPU ' prefix: '${await ojs(`document.getElementById('overlay-cpu')?.textContent ?? ''`)}'`);
  }
  step('m17b-chipnames-off', 'the chip-names toggle OFF: the stock CPU / GPU prefixes return (byte-identical)');

  // (m17e-pollms) M17e (the user addition - "current 500 ms is a bit
  // slow"): the POLLING-RATE slider on the General card + the persisted
  // payload + the FAST-RATE pin. (a) the slider exists with the pinned
  // range (100-2000 ms, step 50) + the 500 default value label; (b) the
  // boot payload carried the default (the overlay's documentElement
  // dataset.overlayPollMs reads '500'); (c) sliding it to 100 persists
  // overlayPollMs=100 AND pushes the payload (the dataset flips to '100')
  // AND the telemetry push RESTARTS at the fast cadence (the
  // dataset.telemetryTicks counter advances >= 2 over a ~500 ms window -
  // the old 500 ms cadence would advance 0-1) AND the overlay FPS poll
  // re-arms at the fast cadence (m17f-fps-fastrate: the fpsPolls dev-probe
  // counter advances >= 2 over ~350 ms - the overlay's own fps loop reads
  // at the slider cadence); (d) restored to 500 so the session stays
  // deterministic.
  if (!(await waitFor(win, `!!document.querySelector('.settings-poll-ms-slider')`, 5000))) {
    fail('M17e: the polling-rate slider is missing on the Overlay General card');
  }
  const pollSlider = `document.querySelector('.settings-poll-ms-slider')`;
  const pollMin = await js(`${pollSlider}?.getAttribute('min')`);
  const pollMax = await js(`${pollSlider}?.getAttribute('max')`);
  const pollStep = await js(`${pollSlider}?.getAttribute('step')`);
  const pollValue = await js(`${pollSlider}?.value`);
  if (pollMin !== '100' || pollMax !== '2000' || pollStep !== '50' || pollValue !== '500') {
    fail(`M17e: the polling-rate slider is ${pollMin}..${pollMax} step ${pollStep} value ${pollValue} (expected 100..2000 step 50 value 500)`);
  }
  if (!(await waitFor(overlayWin, `document.documentElement.dataset.overlayPollMs === '500'`, 5000))) {
    fail(`M17e: the boot overlay:settings payload carried '${await ojs(`document.documentElement.dataset.overlayPollMs ?? ''`)}' (expected '500' - the default cadence)`);
  }
  // Slide to 100 via the UI (input + change - the onchange saves).
  await js(`(() => {
    const s = document.querySelector('.settings-poll-ms-slider');
    s.value = '100';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayPollMs === 100)`, 5000))) {
    fail('M17e: the polling-rate slider did not persist overlayPollMs=100');
  }
  if (!(await waitFor(overlayWin, `document.documentElement.dataset.overlayPollMs === '100'`, 5000))) {
    fail(`M17e: the payload after the slider change is '${await ojs(`document.documentElement.dataset.overlayPollMs ?? ''`)}' (expected '100' - main's reaction must push the new cadence)`);
  }
  // The FAST-RATE pin: the telemetry push honors the 100 ms setting (the
  // live restart - the counter advances at the fast cadence).
  const ticksBefore = Number(await ojs(`document.documentElement.dataset.telemetryTicks ?? '0'`));
  await sleep(500);
  const ticksAfter = Number(await ojs(`document.documentElement.dataset.telemetryTicks ?? '0'`));
  if (ticksAfter - ticksBefore < 2) {
    fail(`M17e: the telemetry push did not honor the 100 ms setting (${ticksBefore} -> ${ticksAfter} ticks over ~500 ms - expected >= 2 at the restarted cadence)`);
  }
  // (m17f-fps-fastrate) M17f: the FPS-poll cadence follows the SAME slider -
  // the overlay's fps loop re-armed at the 100 ms cadence. The assertable
  // surface is the main-side fpsPolls dev-probe counter (the mock/ui-verify
  // path has no present lane - the fps content is null, the counter is the
  // poll count). At 100 ms the counter advances >= 2 over ~350 ms; the old
  // 1000 ms cadence would advance 0-1 (the pre-M17f fixed cadence).
  const fpsPollsBefore = getFpsPolls();
  await sleep(350);
  const fpsPollsAfter = getFpsPolls();
  if (fpsPollsAfter - fpsPollsBefore < 2) {
    fail(`M17f: the overlay FPS poll did not honor the 100 ms setting (${fpsPollsBefore} -> ${fpsPollsAfter} fps-polls over ~350 ms - expected >= 2 at the re-armed cadence)`);
  }
  step('m17e-pollms', `M17e: the polling-rate slider (${pollMin}..${pollMax} step ${pollStep}, default 500) - sliding to 100 persisted overlayPollMs=100 + pushed the payload (dataset '100') + the push restarted at the fast cadence (${ticksBefore} -> ${ticksAfter} telemetry ticks over ~500 ms) + the FPS poll re-armed (${fpsPollsBefore} -> ${fpsPollsAfter} fps-polls over ~350 ms)`);
  // Restore the 500 default (the later sections expect the seeded shape).
  await js(`(() => {
    const s = document.querySelector('.settings-poll-ms-slider');
    s.value = '500';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayPollMs === 500)`, 5000))) {
    fail('M17e: restoring the polling-rate slider did not persist overlayPollMs=500');
  }
  await sleep(150);

  // (f3) M6: the stat tickboxes round-trip through profiles-settings-save.
  // Unchecking gpu-fan trims the persisted overlayStats AND the overlay
  // gpuLine loses the RPM field (a stat off -> its field vanishes); the
  // re-check restores both.
  await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="gpu-fan"]'); if (b) b.click(); })()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayStats.includes('gpu-fan') === false)`, 5000))) {
    fail('M6: unchecking the gpu-fan tickbox did not persist overlayStats without gpu-fan');
  }
  if (!(await waitFor(overlayWin, `(document.getElementById('overlay-gpu')?.textContent ?? '').includes('RPM') === false`, 5000))) {
    fail(`M6: the overlay gpuLine still shows the fan after unchecking gpu-fan: '${await ojs(`document.getElementById('overlay-gpu')?.textContent ?? ''`)}'`);
  }
  await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="gpu-fan"]'); if (b) b.click(); })()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayStats.includes('gpu-fan'))`, 5000))) {
    fail('M6: re-checking the gpu-fan tickbox did not restore overlayStats');
  }
  if (!(await waitFor(overlayWin, `(document.getElementById('overlay-gpu')?.textContent ?? '').includes('RPM')`, 5000))) {
    fail('M6: the overlay gpuLine did not regain the fan after re-checking gpu-fan');
  }
  step('m6-stats-tickbox', 'gpu-fan tickbox round trip via profiles-settings-save: uncheck -> persisted overlayStats trimmed + the gpuLine loses RPM; re-check -> restored');

  // (f3b) M7a: the two new FPS-row stats - the 1% Low / 99% FPS tickboxes
  // round-trip like gpu-fan: unchecking BOTH reverts the fps line to the
  // plain frame-rate + AVG / 0.1% Low fields (the fields vanish with their
  // stats), re-checking restores the full pinned line.
  // M13: the Graphics-API row is an INDEPENDENT line - the fpsPin above
  // carries no badge and the api row pins are separate (the percentile
  // uncheck never touches them).
  await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="fps-1pct-low"]'); if (b) b.click(); })()`);
  await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="fps-99pct"]'); if (b) b.click(); })()`);
  const plainFpsPin = mockFps ? 'FPS 60  AVG 58  0.1% Low 42' : 'FPS -  AVG -  0.1% Low -';
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayStats.includes('fps-1pct-low') === false && e.settings.overlayStats.includes('fps-99pct') === false)`, 5000))) {
    fail('M7a: unchecking the 1% Low / 99% FPS tickboxes did not persist overlayStats without them');
  }
  if (!(await waitFor(overlayWin, `(document.getElementById('overlay-fps')?.textContent ?? '').trim() === '${plainFpsPin}'`, 5000))) {
    fail(`M7a: the overlay FPS line is '${await ojs(`document.getElementById('overlay-fps')?.textContent ?? ''`)}' (expected '${plainFpsPin}' after unchecking both new stats)`);
  }
  await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="fps-1pct-low"]'); if (b) b.click(); })()`);
  await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="fps-99pct"]'); if (b) b.click(); })()`);
  if (!(await waitFor(overlayWin, `(document.getElementById('overlay-fps')?.textContent ?? '').trim() === '${fpsPin}'`, 5000))) {
    fail(`M7a: the overlay FPS line did not regain the percentile fields after re-checking: '${await ojs(`document.getElementById('overlay-fps')?.textContent ?? ''`)}'`);
  }
  step('m7a-fps-stats-tickbox', `the 1% Low / 99% FPS tickbox round trip: uncheck both -> the fps line reverts to '${plainFpsPin}'; re-check -> '${fpsPin}' again`);

  // (f3b2) M12: the AVG / 0.1% Low tickboxes round-trip like the 1% Low /
  // 99% FPS pair - unchecking BOTH drops the two fields (the 1% Low /
  // 99% FPS fields stay), re-checking restores the full pinned line.
  await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="fps-avg"]'); if (b) b.click(); })()`);
  await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="fps-01pct-low"]'); if (b) b.click(); })()`);
  const noAvg01Pin = mockFps
    ? 'FPS 60  1% Low 52  99% FPS 58'
    : 'FPS -  1% Low -  99% FPS -';
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayStats.includes('fps-avg') === false && e.settings.overlayStats.includes('fps-01pct-low') === false)`, 5000))) {
    fail('M12: unchecking the AVG / 0.1% Low tickboxes did not persist overlayStats without them');
  }
  if (!(await waitFor(overlayWin, `(document.getElementById('overlay-fps')?.textContent ?? '').trim() === '${noAvg01Pin}'`, 5000))) {
    fail(`M12: the overlay FPS line is '${await ojs(`document.getElementById('overlay-fps')?.textContent ?? ''`)}' (expected '${noAvg01Pin}' after unchecking both new stats)`);
  }
  await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="fps-avg"]'); if (b) b.click(); })()`);
  await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="fps-01pct-low"]'); if (b) b.click(); })()`);
  if (!(await waitFor(overlayWin, `(document.getElementById('overlay-fps')?.textContent ?? '').trim() === '${fpsPin}'`, 5000))) {
    fail(`M12: the overlay FPS line did not regain the AVG / 0.1% Low fields after re-checking: '${await ojs(`document.getElementById('overlay-fps')?.textContent ?? ''`)}'`);
  }
  step('m12-avg01-fps-stats-tickbox', `the AVG / 0.1% Low tickbox round trip: uncheck both -> the fps line reverts to '${noAvg01Pin}'; re-check -> '${fpsPin}' again`);

  // (f3c) M13: the Graphics-API stat - the api tickbox round-trips the
  // Memory/VRAM row pattern now: unchecking it EMPTIES the API row ('' -
  // the fixed div stays, the fps line keeps its badge-free pinned text),
  // re-checking restores 'DX12'. Meaningful ONLY under RID_MOCK_API=1
  // (without the knob the row never fills and the none-case apiPin above
  // already covers it).
  if (mockApi) {
    await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="api"]'); if (b) b.click(); })()`);
    if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayStats.includes('api') === false)`, 5000))) {
      fail('M13: unchecking the Graphics-API tickbox did not persist overlayStats without api');
    }
    if (!(await waitFor(overlayWin, `(document.getElementById('overlay-api')?.textContent ?? '').trim() === ''`, 5000))) {
      fail(`M13: the overlay API row is '${await ojs(`document.getElementById('overlay-api')?.textContent ?? ''`)}' (expected '' after unchecking the api stat - the row empties)`);
    }
    if (!(await waitFor(overlayWin, `(document.getElementById('overlay-fps')?.textContent ?? '').trim() === '${fpsPin}'`, 5000))) {
      fail(`M13: the overlay FPS line changed when the api stat was unchecked: '${await ojs(`document.getElementById('overlay-fps')?.textContent ?? ''`)}' (expected '${fpsPin}' - the api row is independent)`);
    }
    await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="api"]'); if (b) b.click(); })()`);
    if (!(await waitFor(overlayWin, `(document.getElementById('overlay-api')?.textContent ?? '').trim() === 'DX12'`, 5000))) {
      fail(`M13: the overlay API row did not regain 'DX12' after re-checking: '${await ojs(`document.getElementById('overlay-api')?.textContent ?? ''`)}'`);
    }
    step('m13-api-tickbox', `the Graphics-API tickbox round trip: uncheck -> the API row writes '' (the fps line untouched); re-check -> 'DX12' again`);
  } else {
    step('m13-api-tickbox', 'the Graphics-API tickbox round trip SKIPPED (RID_MOCK_API not set - the row never fills; the none-case apiPin above covers it)');
  }

  // (f3d) M14: the Memory-row stat - the memory-util tickbox round-trips
  // like the FPS-row stats: unchecking it empties the row ('' - the fixed
  // div stays), re-checking restores 'RAM 12.4 GB'.
  await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="memory-util"]'); if (b) b.click(); })()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayStats.includes('memory-util') === false)`, 5000))) {
    fail('M14: unchecking the Memory tickbox did not persist overlayStats without memory-util');
  }
  if (!(await waitFor(overlayWin, `(document.getElementById('overlay-memory')?.textContent ?? '').trim() === ''`, 5000))) {
    fail(`M14: the overlay Memory row is '${await ojs(`document.getElementById('overlay-memory')?.textContent ?? ''`)}' (expected '' after unchecking memory-util - the row fully off writes '')`);
  }
  await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="memory-util"]'); if (b) b.click(); })()`);
  if (!(await waitFor(overlayWin, `(document.getElementById('overlay-memory')?.textContent ?? '').trim() === 'RAM 12.4 GB'`, 5000))) {
    fail(`M14: the overlay Memory row did not regain 'RAM 12.4 GB' after re-checking: '${await ojs(`document.getElementById('overlay-memory')?.textContent ?? ''`)}'`);
  }
  step('m14-memory-tickbox', 'the Memory tickbox round trip: uncheck -> the Memory row writes \'\'; re-check -> \'RAM 12.4 GB\' again');

  // (f3d-2) M13: the CPU-row watt field - the cpu-power tickbox round-trips
  // like the Memory/VRAM stats: unchecking it drops the '125.5 W' TAIL from
  // the CPU row (the row itself stays - the watt is a FIELD, not a line -
  // the line ends with the 61|62°C temp instead), re-checking restores the
  // tail. Meaningful ONLY without RID_MOCK_NO_POWER_METER=1 (with the knob
  // the on-shape tail is '-' and the wantCpuWatt pin above already covers
  // the null render).
  if (!noPowerMeter) {
    await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="cpu-power"]'); if (b) b.click(); })()`);
    if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayStats.includes('cpu-power') === false)`, 5000))) {
      fail('M13: unchecking the CPU Wattage tickbox did not persist overlayStats without cpu-power');
    }
    if (!(await waitFor(overlayWin, `/61°C|62°C$/.test((document.getElementById('overlay-cpu')?.textContent ?? '').trim())`, 5000))) {
      fail(`M13: the overlay CPU line still ends with a watt field after unchecking cpu-power: '${await ojs(`document.getElementById('overlay-cpu')?.textContent ?? ''`)}' (expected the 61°C|62°C temp tail)`);
    }
    await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="cpu-power"]'); if (b) b.click(); })()`);
    if (!(await waitFor(overlayWin, `(document.getElementById('overlay-cpu')?.textContent ?? '').trim().endsWith('125.5 W')`, 5000))) {
      fail(`M13: the overlay CPU line did not regain the '125.5 W' watt tail after re-checking: '${await ojs(`document.getElementById('overlay-cpu')?.textContent ?? ''`)}'`);
    }
    step('m13-cpu-power-tickbox', 'the CPU Wattage tickbox round trip: uncheck -> the \'125.5 W\' tail vanishes from the CPU row; re-check -> it restores');
  } else {
    step('m13-cpu-power-tickbox', 'the CPU Wattage tickbox round trip SKIPPED (RID_MOCK_NO_POWER_METER set - the on-shape tail is \'-\'; the wantCpuWatt pin above covers it)');
  }

  // (f3e) M16: the VRAM-row stats - the gpu-vram tickbox round-trips the
  // same way, but the row does NOT empty (the mem-clock + the VRAM-temp
  // fields stay - the row is MemClock;VRAM;VramTEMP): unchecking drops
  // only the '3.0 GB' field, re-checking restores the full row.
  await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="gpu-vram"]'); if (b) b.click(); })()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayStats.includes('gpu-vram') === false)`, 5000))) {
    fail('M12: unchecking the VRAM tickbox did not persist overlayStats without gpu-vram');
  }
  if (!(await waitFor(overlayWin, `(document.getElementById('overlay-vram')?.textContent ?? '').includes('3.0 GB') === false`, 5000))) {
    fail(`M16: the overlay VRAM row still shows the VRAM field after unchecking gpu-vram: '${await ojs(`document.getElementById('overlay-vram')?.textContent ?? ''`)}'`);
  }
  await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="gpu-vram"]'); if (b) b.click(); })()`);
  if (!(await waitFor(overlayWin, `/VRAM 2187 MHz  3\\.0 GB  \\d+°C/.test(document.getElementById('overlay-vram')?.textContent ?? '')`, 5000))) {
    fail(`M16: the overlay VRAM row did not regain the full 'MemClock;VRAM;VramTEMP' row after re-checking: '${await ojs(`document.getElementById('overlay-vram')?.textContent ?? ''`)}'`);
  }
  step('m12-vram-tickbox', 'the VRAM tickbox round trip: uncheck -> the \'3.0 GB\' field vanishes from the VRAM row (mem-clock + vram-temp stay); re-check -> \'VRAM 2187 MHz  3.0 GB  <temp>°C\' again');

  // (f3f) M16 (nit 9b): the GPU-voltage stat - a GPU-row FIELD (between the
  // temp and the power fields), so unchecking it drops ONLY the '0.652 V'
  // field from the GPU line (the row itself stays), re-checking restores
  // the full pinned line.
  await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="gpu-voltage"]'); if (b) b.click(); })()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayStats.includes('gpu-voltage') === false)`, 5000))) {
    fail('M16: unchecking the GPU Voltage tickbox did not persist overlayStats without gpu-voltage');
  }
  if (!(await waitFor(overlayWin, `(document.getElementById('overlay-gpu')?.textContent ?? '').includes('0.652 V') === false`, 5000))) {
    fail(`M16: the overlay GPU line still shows the voltage field after unchecking gpu-voltage: '${await ojs(`document.getElementById('overlay-gpu')?.textContent ?? ''`)}'`);
  }
  if (!(await waitFor(overlayWin, `/GPU 42%  \\d+ MHz  \\d+°C  38\\.8 W  1030 RPM/.test(document.getElementById('overlay-gpu')?.textContent ?? '')`, 5000))) {
    fail(`M16: the GPU line lost more than the voltage field after unchecking gpu-voltage: '${await ojs(`document.getElementById('overlay-gpu')?.textContent ?? ''`)}'`);
  }
  await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="gpu-voltage"]'); if (b) b.click(); })()`);
  if (!(await waitFor(overlayWin, `/GPU 42%  \\d+ MHz  \\d+°C  0\\.652 V  38\\.8 W  1030 RPM/.test(document.getElementById('overlay-gpu')?.textContent ?? '')`, 5000))) {
    fail(`M16: the overlay GPU line did not regain the voltage field after re-checking gpu-voltage: '${await ojs(`document.getElementById('overlay-gpu')?.textContent ?? ''`)}'`);
  }
  step('m16-gpu-voltage-tickbox', 'the GPU Voltage tickbox round trip: uncheck -> the \'0.652 V\' field vanishes from the GPU row (the rest stays); re-check -> the full row again');

  // (f3g) M16 (nit 9b): the VRAM-temp stat - the trailing field of the VRAM
  // row: unchecking drops the '<temp>°C' tail (MemClock;VRAM remain),
  // re-checking restores the full row.
  await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="gpu-vram-temp"]'); if (b) b.click(); })()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayStats.includes('gpu-vram-temp') === false)`, 5000))) {
    fail('M16: unchecking the VRAM temp tickbox did not persist overlayStats without gpu-vram-temp');
  }
  if (!(await waitFor(overlayWin, `(document.getElementById('overlay-vram')?.textContent ?? '').trim() === 'VRAM 2187 MHz  3.0 GB'`, 5000))) {
    fail(`M16: the overlay VRAM row is '${await ojs(`document.getElementById('overlay-vram')?.textContent ?? ''`)}' (expected 'VRAM 2187 MHz  3.0 GB' after unchecking gpu-vram-temp - the temp tail drops, MemClock;VRAM stay)`);
  }
  await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="gpu-vram-temp"]'); if (b) b.click(); })()`);
  if (!(await waitFor(overlayWin, `/VRAM 2187 MHz  3\\.0 GB  \\d+°C/.test(document.getElementById('overlay-vram')?.textContent ?? '')`, 5000))) {
    fail(`M16: the overlay VRAM row did not regain the temp field after re-checking gpu-vram-temp: '${await ojs(`document.getElementById('overlay-vram')?.textContent ?? ''`)}'`);
  }
  step('m16-vram-temp-tickbox', 'the VRAM temp tickbox round trip: uncheck -> the \'<temp>°C\' tail vanishes from the VRAM row (MemClock;VRAM stay); re-check -> \'VRAM 2187 MHz  3.0 GB  <temp>°C\' again');

  // (f4) M6: the frametime stat is NOT a line - unchecking it HIDES the
  // canvas strip AND the value line below it (M6-amd2: the stat controls
  // both; the fixed divs stay, the strip + the number go display:none).
  await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="frametime"]'); if (b) b.click(); })()`);
  if (!(await waitFor(overlayWin, `document.getElementById('overlay-frametime')?.style.display === 'none'`, 5000))) {
    fail('M6: the frametime canvas is still visible after unchecking the frametime stat');
  }
  if (!(await waitFor(overlayWin, `document.getElementById('overlay-frametime-value')?.style.display === 'none'`, 5000))) {
    fail('M6-amd2: the frametime value line is still visible after unchecking the frametime stat');
  }
  await js(`(() => { const b = document.querySelector('.overlay-stat-checkbox[data-stat-id="frametime"]'); if (b) b.click(); })()`);
  if (!(await waitFor(overlayWin, `document.getElementById('overlay-frametime')?.style.display !== 'none'`, 5000))) {
    fail('M6: the frametime canvas did not come back after re-checking the frametime stat');
  }
  if (!(await waitFor(overlayWin, `document.getElementById('overlay-frametime-value')?.style.display !== 'none'`, 5000))) {
    fail('M6-amd2: the frametime value line did not come back after re-checking the frametime stat');
  }
  step('m6-frametime-toggle', 'frametime tickbox round trip: uncheck -> canvas + value line hidden; re-check -> both visible again');

  // (f5) M6: the color swatches - clicking the yellow swatch persists
  // overlayColor '#ffe600' AND the overlay re-renders with the color: the
  // --overlay-color CSS var on <html>, the computed line color, and (under
  // RID_MOCK_FPS=1, where the canvas has drawn content) the canvas
  // strokeStyle all take the SAME hex - never the old hardcoded white.
  await js(`(() => { const b = document.querySelector('.overlay-color-option[data-color-option="#ffe600"]'); if (b) b.click(); })()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayColor === '#ffe600')`, 5000))) {
    fail('M6: the yellow swatch did not persist overlayColor #ffe600');
  }
  if (!(await waitFor(overlayWin, `document.documentElement.style.getPropertyValue('--overlay-color') === '#ffe600'`, 5000))) {
    fail(`M6: the overlay --overlay-color CSS var reads '${await ojs(`document.documentElement.style.getPropertyValue('--overlay-color')`)}' (expected '#ffe600')`);
  }
  if (!(await waitFor(overlayWin, `getComputedStyle(document.getElementById('overlay-cpu')).color === 'rgb(255, 230, 0)'`, 5000))) {
    fail(`M6: the overlay line computed color reads '${await ojs(`getComputedStyle(document.getElementById('overlay-cpu')).color`)}' (expected rgb(255, 230, 0))`);
  }
  if (mockFps) {
    const stroke = await ojs(`(() => { const c = document.getElementById('overlay-frametime'); if (!c || c.width === 0) return null; const ctx = c.getContext('2d'); return ctx ? ctx.strokeStyle : null; })()`);
    if (stroke !== '#ffe600') {
      fail(`M6: the frametime canvas strokeStyle reads '${stroke}' (expected '#ffe600' - the canvas must take the same hex as the lines)`);
    }
    step('m6-color-canvas-stroke', `the frametime canvas strokeStyle took the SAME hex ('${stroke}') - never the old hardcoded white`);
  } else {
    step('m6-color-canvas-stroke', 'canvas stroke color pin SKIPPED (RID_MOCK_FPS not set - no series, nothing drawn)');
  }
  // Restore the stock white (the deterministic session end).
  await js(`window.arcPower.profilesSettingsSave({ overlayColor: '#ffffff' })`);
  if (!(await waitFor(overlayWin, `document.documentElement.style.getPropertyValue('--overlay-color') === '#ffffff'`, 5000))) {
    fail('M6: the white restore did not re-render the overlay (--overlay-color still non-white)');
  }
  step('m6-color-swatch', 'yellow swatch -> overlayColor #ffe600 persisted + the overlay re-rendered (css var + computed line color + canvas stroke); restored to the stock white');

  // (f6) M7b (fix 4): the background box - the Appearance card's
  // Background section. (a) the toggle persists overlayBgEnabled + the
  // overlay's backdrop gains the .visible class; (b) a swatch round trip
  // persists overlayBgColor + re-renders the --overlay-bg-color CSS var;
  // (c) the opacity slider (0-100) persists overlayBgOpacity + re-renders
  // the --overlay-bg-opacity CSS var; (d) off -> the backdrop hides again.
  // The overlay view of the Monitoring page is active here (the
  // Settings-button block above navigated there; the M9 .settings-position-
  // select lives in the SAME Appearance card now - the position pins below
  // run against this card).
  if (!(await waitFor(win, `!!document.querySelector('.settings-checkbox[data-setting="overlayBgEnabled"]')`, 5000))) {
    fail('M7b: the overlay view Appearance card has no overlayBgEnabled toggle');
  }
  // The boot defaults: box off, black, 0.5 - the backdrop is hidden + the
  // CSS vars carry the defaults (the seeded session).
  if (await ojs(`document.getElementById('overlay-backdrop')?.classList.contains('visible')`)) {
    fail('M7b: the backdrop must boot HIDDEN (overlayBgEnabled defaults to false)');
  }
  const bootBgVars = await ojs(`JSON.stringify({ color: document.documentElement.style.getPropertyValue('--overlay-bg-color'), opacity: document.documentElement.style.getPropertyValue('--overlay-bg-opacity') })`);
  const bootBg = JSON.parse(bootBgVars);
  if (bootBg.color !== '#000000' || bootBg.opacity !== '0.5') {
    fail(`M7b: the boot background vars read ${bootBgVars} (expected color '#000000' + opacity '0.5' - the seeded defaults)`);
  }
  // (a) the toggle on: the backdrop appears + the overlay re-renders (the
  // overlayChanged loop must carry the bg keys or the box never appears).
  await js(`(() => { const b = document.querySelector('.settings-checkbox[data-setting="overlayBgEnabled"]'); b.click(); })()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayBgEnabled === true)`, 5000))) {
    fail('M7b: the bg toggle did not persist overlayBgEnabled=true');
  }
  if (!(await waitFor(overlayWin, `document.getElementById('overlay-backdrop')?.classList.contains('visible')`, 5000))) {
    fail('M7b: the backdrop did not gain .visible after the bg toggle (the push must re-render the box)');
  }
  if (!(await waitFor(overlayWin, `getComputedStyle(document.getElementById('overlay-backdrop')).display === 'block'`, 5000))) {
    fail('M7b: the visible backdrop computes display:block');
  }
  // (b) the yellow swatch round trip: overlayBgColor '#ffe600' persists +
  // the --overlay-bg-color var re-renders.
  await js(`(() => { const b = document.querySelector('.overlay-bg-color-option[data-bg-color-option="#ffe600"]'); if (b) b.click(); })()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayBgColor === '#ffe600')`, 5000))) {
    fail('M7b: the yellow bg swatch did not persist overlayBgColor #ffe600');
  }
  if (!(await waitFor(overlayWin, `document.documentElement.style.getPropertyValue('--overlay-bg-color') === '#ffe600'`, 5000))) {
    fail(`M7b: the --overlay-bg-color var reads '${await ojs(`document.documentElement.style.getPropertyValue('--overlay-bg-color')`)}' (expected '#ffe600' after the swatch)`);
  }
  // (c) the opacity slider: 30 -> overlayBgOpacity 0.3 persists + the var
  // re-renders (the live value label follows the oninput pattern).
  await js(`(() => {
    const s = document.querySelector('.settings-bg-opacity-slider');
    if (!s) return;
    s.value = '30';
    s.dispatchEvent(new Event('change'));
  })()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayBgOpacity === 0.3)`, 5000))) {
    fail('M7b: the opacity slider did not persist overlayBgOpacity 0.3');
  }
  if (!(await waitFor(overlayWin, `document.documentElement.style.getPropertyValue('--overlay-bg-opacity') === '0.3'`, 5000))) {
    fail(`M7b: the --overlay-bg-opacity var reads '${await ojs(`document.documentElement.style.getPropertyValue('--overlay-bg-opacity')`)}' (expected '0.3' after the slider)`);
  }
  if (!(await waitFor(overlayWin, `getComputedStyle(document.getElementById('overlay-backdrop')).opacity === '0.3'`, 5000))) {
    fail('M7b: the backdrop computed opacity did not follow the slider (expected 0.3)');
  }
  // (d) off again: the backdrop hides (the .visible class drops) + the
  // persisted value flips back.
  await js(`(() => { const b = document.querySelector('.settings-checkbox[data-setting="overlayBgEnabled"]'); b.click(); })()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayBgEnabled === false)`, 5000))) {
    fail('M7b: the bg toggle off did not persist overlayBgEnabled=false');
  }
  if (!(await waitFor(overlayWin, `document.getElementById('overlay-backdrop')?.classList.contains('visible') === false`, 5000))) {
    fail('M7b: the backdrop is still visible after the bg toggle off');
  }
  step('m7b-background', 'M7b background: toggle on -> backdrop .visible + display:block; yellow swatch -> overlayBgColor #ffe600 + the CSS var; opacity slider 30 -> overlayBgOpacity 0.3 + the computed opacity; toggle off -> hidden again');

  // (g) the mid-run register-failure honesty: the probe fakes a failure
  // (settable mid-run - not a boot-time knob), a letter save via the
  // Overlay view (the #/overlay hash redirects here with the view active -
  // the hotkey input MOVED into the Monitoring page with the rest, M9; the
  // view KEEPS the .settings-hotkey-input class so the selector survived)
  // re-registers through the probe, and the honest note appears after the
  // every-render get-state re-query (M1: a letter-save re-register failure
  // mid-session must not leave the note stale).
  hotkeyProbe.failRegister = true;
  await js(`location.hash = '#/overlay'`);
  if (!(await waitFor(win, `!!document.querySelector('.settings-hotkey-input')`, 8000))) {
    fail('M9: the #/overlay alias did not render the Overlay view (no hotkey input)');
  }
  await js(`(() => {
    const i = document.querySelector('.settings-hotkey-input');
    if (!i) return;
    i.value = 'P';
    i.dispatchEvent(new Event('change'));
  })()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.overlayHotkeyLetter === 'P')`, 5000))) {
    fail('M5: the Overlay Settings page letter save did not persist overlayHotkeyLetter=P');
  }
  if (!hotkeyProbe.registrations.includes('Control+P')) {
    fail(`M5: the letter save did not re-register through the probe (got ${JSON.stringify(hotkeyProbe.registrations)})`);
  }
  const s4 = await js(`window.arcPower.overlayGetState()`);
  if (s4.hotkeyRegistered !== false) fail('M5: hotkeyRegistered must read false after the faked register failure');
  if (!(await waitFor(win, `(document.getElementById('page')?.textContent ?? '').includes('could not be registered')`, 5000))) {
    fail('M5: the Overlay Settings page does not show the honest hotkey-register-failure note after the faked failure + letter save');
  }
  const inputValue = await js(`document.querySelector('.settings-hotkey-input')?.value ?? ''`);
  if (inputValue !== 'P') fail(`M5: the Overlay Settings hotkey input reads '${inputValue}' (expected 'P' after the save)`);
  step('m5-hotkey-failure-note', `mid-run faked register failure + letter save 'P' -> probe re-registered 'Control+P', hotkeyRegistered false, the honest note appears (input '${inputValue}')`);

  // Restore the deterministic session end (like the theme-dark-final step):
  // letter O + a successful registration -> the note disappears, and the
  // geometry back to the defaults (a crashed run must never bleed into the
  // next overlay variant; the M6 color/stats pins already restored the
  // stock white + the full stat set above, and the M7b bg pins restore the
  // box off/black/0.5 here).
  hotkeyProbe.failRegister = false;
  await js(`window.arcPower.profilesSettingsSave({ overlayHotkeyLetter: 'O', overlayPosition: 'top-left', overlayScale: 1, overlayBgEnabled: false, overlayBgColor: '#000000', overlayBgOpacity: 0.5 })`);
  await sleep(500);
  const s5 = await js(`window.arcPower.overlayGetState()`);
  if (s5.hotkeyRegistered !== true) fail('M5: hotkeyRegistered did not recover after the failure fake was cleared');
  if (!hotkeyProbe.registrations.includes('Control+O')) {
    fail(`M5: the restore letter save did not re-register 'Control+O' (got ${JSON.stringify(hotkeyProbe.registrations)})`);
  }
  await js(`location.hash = '#/dashboard'`);
  await js(`location.hash = '#/overlay'`);
  if (!(await waitFor(win, `!!document.querySelector('.settings-hotkey-input')`, 8000))) {
    fail('M9: the #/overlay alias did not re-render the Overlay view');
  }
  await sleep(250);
  if (await js(`(document.getElementById('page')?.textContent ?? '').includes('could not be registered')`)) {
    fail('M5: the hotkey-failure note is still visible after the successful re-registration (the page must re-query get-state on every render)');
  }
  step('m5-hotkey-restore', `restore: letter O + failRegister cleared -> 'Control+O' re-registered, hotkeyRegistered true, note gone; geometry back to top-left / scale 1`);

  // M4-D2 (§1): the shared close-to-tray REAL close probe - the LAST step.
  // The main window's closed handler destroys the overlay + unregisters the
  // hotkey (the lifecycle rule) - the app must still quit when the main
  // window closes with closeToTray off.
  await runCloseToTrayProbe(win);
  if (!overlayWin.isDestroyed()) {
    fail('M5: the overlay window survived the main window close (the closed handler must destroy it - the app must quit when the main window closes)');
  }

  console.log('\nUI VERIFY OK (overlay)\n' + steps.map((s) => '  ' + s).join('\n'));
  app.exit(0);
}
