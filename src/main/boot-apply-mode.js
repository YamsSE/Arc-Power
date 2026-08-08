// Arc Power - M4-E --boot-apply CLI mode orchestration (electron-free).
//
// The ArcPowerBootApply logon task runs ELEVATED with the FIXED action
// `"<installed exe>" --boot-apply`. This mode is the task's action: it reads
// the ACTIVE profile from the store (like the window-path boot apply - no id
// argument) and:
//   - settings.ocOnBoot !== true || !activeProfileId -> silent exit 0
//     (no window, no tray - the task's logon spawn is invisible when off);
//   - on -> the boot-gated in-process apply (applyProfileBoot: applyRunner-
//     less, defaults-restore fallback skipped regardless of errorCode -
//     logon must never wipe the live OC state; the task runs elevated so the
//     in-process apply persists), then exit in BOTH outcomes:
//     success -> exit right after the apply; failure -> tray balloon + a
//     short dwell (so the balloon is visible) + exit 0. An invisible
//     elevated process + tray icon must NEVER linger after a logon apply.
//
// Electron-free so the whole flow is unit-testable under plain node --test
// with injected deps (mirrors runApplyOnStartup's test shape). The caller
// (main.js) owns app.exit(0) after the returned outcome.

import { trayBalloonForOutcome } from './tray.js';

/** The failure balloon's visibility dwell before the process exits. */
export const BOOT_APPLY_DWELL_MS = 10000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{
 *   store: import('./store/profile-store.js').ProfileStore,
 *   apply: (profileId: string) => Promise<{ applied: boolean, reason: string, [k: string]: unknown }>,
 *   setupTray: () => Promise<{ displayBalloon: (o: { title: string, content: string }) => void }>,
 *   log?: (s: string) => void,
 *   dwellMs?: number,
 * }} ctx
 * @returns {Promise<{
 *   action: 'silent-exit' | 'applied' | 'failed',
 *   reason?: string,
 * }>}
 */
export async function runBootApplyMode({ store, apply, setupTray, log = () => {}, dwellMs = BOOT_APPLY_DWELL_MS }) {
  let settings;
  try {
    settings = await store.loadSettings();
  } catch (err) {
    // A settings read failure at logon: exit silently (a logon task must
    // never error-spam or hang the session) - the window path's honest
    // state lines still surface the problem for the user.
    log(`settings read failed (${err.message}) - silent exit`);
    return { action: 'silent-exit' };
  }
  if (settings.ocOnBoot !== true || !settings.activeProfileId) {
    log('ocOnBoot is off or no active profile - silent exit');
    return { action: 'silent-exit' };
  }

  let out;
  try {
    out = await apply(settings.activeProfileId);
  } catch (err) {
    out = { applied: false, reason: `apply threw: ${err.message}` };
  }
  if (out.applied === true) {
    log(`applied profile '${settings.activeProfileId}' - exiting`);
    return { action: 'applied' };
  }

  // Failure: the honest balloon, a visible dwell, then the caller exits.
  // The balloon never claims "defaults restored" unless a restore actually
  // ran (trayBalloonForOutcome's contract).
  log(`NOT applied: ${out.reason}`);
  try {
    const profiles = await store.loadProfiles().catch(() => []);
    const name = (profiles.find((p) => p.id === settings.activeProfileId) ?? {}).name ?? settings.activeProfileId;
    const content = trayBalloonForOutcome(out, name);
    if (content) {
      const tray = await setupTray();
      tray.displayBalloon({ title: 'Arc Power', content });
      log(`tray balloon sent: ${content}`);
    }
  } catch (err) {
    // The tray/balloon is best-effort - the exit semantics must not depend
    // on it (a logon session without a shell notification surface).
    log(`failure balloon skipped: ${err.message}`);
  }
  log(`dwelling ${dwellMs} ms so the failure balloon is visible, then exiting`);
  await sleep(dwellMs);
  return { action: 'failed', reason: out.reason };
}
