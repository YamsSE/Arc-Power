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
import { activeProfileEntries } from './store/profile-store.js';
import { TRAY_BALLOON_TITLE, trayBalloonForOutcome } from './tray.js';
// M24 (Part B): the channel vocabulary is HOISTED into ipc-core.js (the
// owner of the channel names); this module re-exports the constant
// additively so the existing send site below keeps working unchanged -
// importing it from tray-apply.js would drag the apply/tray graph into
// ipc.js. (Import for the local send site + re-export: a bare
// `export { X } from` creates NO local binding.)
import { DEVICE_STATE_UPDATED_CHANNEL } from './ipc-core.js';
export { DEVICE_STATE_UPDATED_CHANNEL };

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
    const profiles = await store.loadProfiles();
    const entries = activeProfileEntries(settings, profiles);
    // M152: tray apply is per physical GPU. A multi-GPU session may have one
    // active profile for each adapter; applying only the legacy scalar would
    // silently leave the other tuned GPU untouched.
    const results = [];
    for (const entry of entries) {
      let entryDeviceId = null;
      let out;
      try {
        // Resolve each profile independently. A stale/missing adapter for one
        // map entry must not prevent the other physical GPUs from applying.
        entryDeviceId = await resolveApplyDeviceId(backend, store, null, entry.deviceKey ?? undefined);
        out = await applyProfile({
          backend,
          store,
          profileId: entry.profileId,
          deviceKey: entry.deviceKey,
          deviceId: entryDeviceId,
          oldIgcl,
          applyRunner,
          sysmanPowerLimits,
        });
      } catch (err) {
        out = { applied: false, reason: `profile apply threw: ${err.message}` };
      }
      results.push({ entry, out });
      // M16-F1 (D2): push each adapter's fresh post-apply read-back. The
      // payload carries that adapter's session id, so the renderer never
      // mistakes GPU 2's state for GPU 1's.
      if (out.state != null) {
        const win = getWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send(DEVICE_STATE_UPDATED_CHANNEL, { deviceId: entryDeviceId, deviceKey: entry.deviceKey ?? null, state: out.state });
        }
      }
    }
    for (const { entry, out } of results) {
      // The balloon only claims "defaults restored" when a restore actually
      // ran. Failure for one adapter must not prevent the remaining profiles
      // from being attempted.
      if (!out.applied) {
        const tray = getTray();
        if (tray && !tray.isDestroyed()) {
          const content = trayBalloonForOutcome(out, entry.profile?.name ?? entry.profileId);
          if (content) tray.displayBalloon({ title: TRAY_BALLOON_TITLE, content });
        }
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
