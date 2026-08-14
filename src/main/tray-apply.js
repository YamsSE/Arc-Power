// Arc Power - the tray "Apply active profile" action (electron-free,
// unit-testable under plain `node --test`).
//
// The tray apply runs ENTIRELY in main - the renderer never sees the
// apply's result, so its dashboard OC status row (which derives its
// stock-state verdict from the LIVE driver read-back, M16) would keep the
// stale pre-apply verdict for the rest of the session. M16-F1 (D2): after
// the shared apply flow produces a fresh read-back, this module pushes it
// to the renderer through the device:state-updated channel (the renderer's
// store.state slot - the dashboard render signature includes it, so the
// row re-renders in place). The balloon contract is unchanged (M2b review
// F1: "defaults restored" only when a restore actually ran; refusals get
// the reason-specific message).

import { applyProfile, resolveApplyDeviceId } from './apply-on-boot.js';
import { TRAY_BALLOON_TITLE, trayBalloonForOutcome } from './tray.js';

/** The pushed post-apply device read-back channel (main -> renderer). */
export const DEVICE_STATE_UPDATED_CHANNEL = 'device:state-updated';

/**
 * The tray menu's "Apply active profile" click handler (M2b). Applies the
 * profile currently set as active in the persisted settings, balloons the
 * outcome like the boot path, and - M16-F1 - PUSHES the fresh post-apply
 * read-back to the main window so the dashboard OC status row flips in
 * place. The apply targets the PERSISTED/SELECTED device (M4-F S2:
 * explicit id ?? persisted ?? devices[0], resolved like every other apply
 * path).
 *
 * M3-C-D (double-dialog decision): the per-apply extended-range confirm is
 * DROPPED from the tray entirely - in Advanced mode the mode-enable
 * confirm already warned; in Stock mode the shared oc-mode gate refuses
 * extended values with a balloon (never a dead-end confirm). applyProfile
 * below owns that honesty. Explicit user action: skips the ocOnBoot gate
 * (like the renderer's Load button) but keeps the waiver gates.
 *
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   store: import('./store/profile-store.js').ProfileStore,
 *   oldIgcl?: object | null,
 *   applyRunner?: object | null,
 *   sysmanPowerLimits?: object | null,  // M17i: the sysman PL2 companion
 *                                       // source - the tray apply is an
 *                                       // in-process electron+IGCL apply,
 *                                       // so main wires the HELPER PROXY
 *                                       // (the IGCL-free delegation)
 *   getWindow?: () => ({ isDestroyed: () => boolean, webContents: { send: (channel: string, payload: unknown) => void } }) | null,
 *   getTray?: () => ({ isDestroyed: () => boolean, displayBalloon: (o: { title: string, content: string }) => void }) | null,
 *   log?: (s: string) => void,
 * }} deps
 * @returns {Promise<void>}
 */
export async function trayApplyActiveProfile({ backend, store, oldIgcl = null, applyRunner = null, sysmanPowerLimits = null, getWindow = () => null, getTray = () => null, log = console.error }) {
  try {
    const settings = await store.loadSettings();
    // M4-F (S2): the tray apply targets the PERSISTED/SELECTED device
    // (resolved like every other apply - explicit id ?? persisted ?? devices[0]).
    const deviceId = await resolveApplyDeviceId(backend, store, null);
    const out = await applyProfile({ backend, store, profileId: settings.activeProfileId, deviceId, oldIgcl, applyRunner, sysmanPowerLimits });
    // M16-F1 (D2): push the fresh post-apply read-back to the renderer so
    // the dashboard OC status row (derived from the LIVE driver values)
    // flips in place - a tray apply must never leave the stale pre-apply
    // verdict. Pushed on a SUCCESSFUL apply AND on the defaults-restored
    // failure (both carry the post-apply read-back); gate refusals and
    // degraded read-backs carry null/undefined and never push (nothing
    // changed on the driver - the renderer keeps its honest state).
    if (out.state != null) {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(DEVICE_STATE_UPDATED_CHANNEL, { deviceId, state: out.state });
      }
    }
    // The balloon only claims "defaults restored" when a restore actually
    // ran (M2b review F1) - gate refusals (incl. the oc-mode refusal) get
    // a reason-specific message.
    if (!out.applied) {
      const tray = getTray();
      if (tray && !tray.isDestroyed()) {
        let name = 'unknown';
        try {
          const ps = await store.loadProfiles();
          const p = ps.find((x) => x.id === settings.activeProfileId);
          if (p) name = p.name;
        } catch { /* best effort name */ }
        const content = trayBalloonForOutcome(out, name);
        if (content) tray.displayBalloon({ title: TRAY_BALLOON_TITLE, content });
      }
    }
  } catch (err) {
    log(`[tray] apply active profile failed: ${err.message}`);
    const tray = getTray();
    if (tray && !tray.isDestroyed()) {
      tray.displayBalloon({ title: TRAY_BALLOON_TITLE, content: `Arc Power: profile apply failed - ${err.message}` });
    }
  }
}
