// Arc Power - M2b/M2C-C apply-on-startup flow (`--apply-profile <id>`) and
// the shared profile-apply flow (tray "Apply active profile").
//
// Electron-free so the whole flow is testable under plain `node --test`
// with MockBackend. Gates: the persisted settings must have waiverAccepted
// (the waiver must also be accepted on the device - seedWaiverState runs
// before this at boot). The ocOnBoot gate applies ONLY to the boot path:
// an explicit user action (tray click, renderer Load) skips it but keeps
// the waiver gates. Applies the profile with read-back verification (the
// backend's per-control read-back + the routing layer's delayed re-read);
// on failure applies defaults (resetToDefaults) and reports the fallback -
// never a silent partial apply. The "defaults restored" claim is only ever
// made when a restore actually ran (fallbackApplied !== undefined).
// M4O (user decision): the OC-MODE gate NEVER blocks a profile apply - the
// stock/advanced mode is the interactive SLIDER gate only; a saved profile
// applies as saved against the driver's TRUE limits (the extended W/C
// maxes), with the >315 W ceiling refusal + the runtime-capability refusal
// still in place (see applyProfile below).
// M4-D (PERMANENT acceptance): when the apply answers waiver-not-set with a
// PERSISTED acceptance (settings.waiverAccepted), the flow silently re-sets
// the driver waiver and retries the apply ONCE (mirror runApply) before any
// defaults fallback - the logon/tray apply must honor the user's permanent
// consent, never restore defaults over a stale driver waiver.
//
// M2C-C: the apply goes through the ROUTED core (DriverStore runtime for
// values within range, bundled 2023 runtime above 252 W / 90 C) and through
// the elevation-aware apply runner - the boot task runs elevated (/rl
// highest), so its runner applies in-process; a manually-launched
// non-elevated instance fails honestly per control.

import { TRAY_BALLOON_TITLE, trayBalloonForOutcome } from './tray.js';
import { executeApply, ocModeRefusal, extendedUnavailableRefusal, OC_MODE_ADVANCED } from './apply-routing.js';

/** Any per-control result carrying the waiver-not-set driver answer. */
const hasWaiverNotSet = (result) => Object.values(result?.perControl ?? {})
  .some((p) => p?.errorCode === 'waiver-not-set');

/**
 * M4-F (S2): resolve the apply's target device. Priority:
 *   1. an explicit `deviceId` that matches an enumerated device;
 *   2. the persisted settings' deviceId (when it matches an enumerated id);
 *   3. devices[0] (the historical behavior - a 1-device machine is
 *      unaffected; the persisted/selected device is honored on 2-GPU
 *      machines so a logon apply never silently targets the iGPU).
 * Returns null when no devices are enumerated (callers degrade).
 * @param {import('./backend/backend.interface.js').IOCBackend} backend
 * @param {import('./store/profile-store.js').ProfileStore} store
 * @param {number|null|undefined} explicitDeviceId
 * @returns {Promise<number|null>}
 */
export async function resolveApplyDeviceId(backend, store, explicitDeviceId = null) {
  const devices = await backend.listDevices();
  if (devices.length === 0) return null;
  const ids = new Set(devices.map((d) => d.id));
  if (Number.isInteger(explicitDeviceId) && ids.has(explicitDeviceId)) return explicitDeviceId;
  let settings = null;
  try {
    settings = await store.loadSettings();
  } catch {
    // degraded: never fall back on an unreadable store beyond devices[0]
  }
  const persisted = settings?.deviceId;
  if (Number.isInteger(persisted) && ids.has(persisted)) return persisted;
  return devices[0].id;
}

/**
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   store: import('./store/profile-store.js').ProfileStore,
 *   profileId: string,
 *   deviceId?: number | null,    // M4-F: explicit target device (default:
 *                                // persisted settings' deviceId ?? devices[0].id)
 *   log?: (s: string) => void,
 *   requireOcOnBoot?: boolean,   // boot path only; explicit actions skip it
 *   oldIgcl?: object,            // M2C-C: bundled-2023-runtime adapter (null in tests that never extend)
  *   applyRunner?: object | null, // M2C-C: elevation-aware apply runner (null = in-process)
  *   skipDefaultsFallback?: boolean,  // M4M: the app-start boot variant -
  *                                    // NEVER restores defaults (keyed on
  *                                    // the SESSION, not the errorCode: the
  *                                    // packaged app is always elevated -
  *                                    // the failure is never an elevation
  *                                    // refusal, yet a live-OC wipe over
  *                                    // any failure stays forbidden)
  * }} ctx
 * @returns {Promise<{
 *   applied: boolean,
 *   reason: string,
 *   fallbackApplied?: boolean,
 *   result?: unknown,
 *   state?: unknown,
 * }>}
 */
export async function applyProfile({ backend, store, profileId, deviceId = null, log = () => {}, requireOcOnBoot = false, oldIgcl = null, applyRunner = null, skipDefaultsFallback = false }) {
  const settings = await store.loadSettings();
  if (requireOcOnBoot && settings.ocOnBoot !== true) {
    return { applied: false, reason: 'Start-at-boot is disabled' };
  }
  if (settings.waiverAccepted !== true) {
    return { applied: false, reason: 'Waiver not accepted' };
  }

  let targetDeviceId;
  try {
    targetDeviceId = await resolveApplyDeviceId(backend, store, deviceId);
  } catch (err) {
    return { applied: false, reason: `device enumeration failed: ${err.message}` };
  }
  if (targetDeviceId === null) {
    return { applied: false, reason: 'no devices enumerated' };
  }
  const deviceId_ = targetDeviceId;

  let caps;
  try {
    caps = await backend.getCapabilities(deviceId_);
  } catch (err) {
    return { applied: false, reason: `capability query failed: ${err.message}` };
  }
  if (caps.waiverAccepted !== true) {
    // The driver lost the waiver since the last session - never auto-accept.
    return { applied: false, reason: 'waiver not accepted on the device' };
  }

  const profiles = await store.loadProfiles();
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) {
    return { applied: false, reason: `profile '${profileId}' not found` };
  }

  // M4O (user decision): the OC-mode gate is the INTERACTIVE slider gate
  // ONLY - a profile apply (window boot apply, logon task, --apply-profile,
  // tray "Apply active profile", the Profiles-page Apply button) honors the
  // saved values as the user configured them ("it doesn't matter if the
  // Profile uses Advanced Settings or not"). The stock/advanced mode is an
  // app-side UI safety gate (settings.json; seedOcMode; the backend's caps
  // ranges); the driver's REAL limits ARE the extended ones (the live-
  // verified 315 W KMD ceiling), so the mode must not refuse a saved
  // profile. The CEILING refusal STAYS - a profile ABOVE the extended
  // ceiling (>315 W / >115 C - hand-edited settings, profiles-save never
  // clamps) must still refuse with OC_CEILING_REFUSAL_MSG, NEVER silently
  // clamp to 315 and report ok:true (the "silent clamp reported as applied"
  // class the codebase forbids). The refusal classification is unchanged: a
  // config refusal reports the reason ONLY and never runs the reset-to-
  // defaults fallback (fallbackApplied stays undefined).
  const refusal = ocModeRefusal(OC_MODE_ADVANCED, profile.settings, caps.ranges);
  if (refusal) {
    log(`[apply-on-boot] ceiling refusal (${refusal.mode}): ${refusal.message} (${refusal.controls.join(', ')}) - nothing applied, NO defaults restore`);
    return { applied: false, reason: refusal.message, ocModeRefused: true };
  }

  // M3-C step-5 F1: advanced mode + a NOT-capable bundled 2023 runtime (the
  // future-driver degradation) -> refuse the profile's extended values
  // BEFORE any apply, never a silent 252 W / 90 C clamp reported as applied.
  // Same refusal classification as the mode gate: no defaults-restore
  // fallback, the live OC state survives, and the tray balloon is the
  // reason-specific refusal (fallbackApplied stays undefined).
  // M4O: the gate keys on the RUNTIME capability, NOT the mode-gated
  // caps.extendedRanges flag - the backends only set that flag in advanced
  // mode, so in stock mode it is false even when the bundled 2023 runtime
  // IS capable (the second blocker in the user report). The true probe is
  // oldIgcl.isCapable() (mock: createMockOldIgcl -> backend.extendedCapable
  // - the RAW featureset flag, mode-independent). A genuinely not-capable
  // driver still refuses honestly with EXTENDED_UNAVAILABLE_MSG.
  const extendedCapable = oldIgcl ? await oldIgcl.isCapable() : caps.extendedRanges === true;
  const unavailable = extendedUnavailableRefusal(profile.settings, { ...caps, extendedRanges: extendedCapable });
  if (unavailable) {
    log(`[apply-on-boot] extended-unavailable refusal: ${unavailable.message} (${unavailable.controls.join(', ')}) - nothing applied, NO defaults restore`);
    return { applied: false, reason: unavailable.message, extendedUnavailable: true };
  }

  log(`[apply-on-boot] applying profile '${profile.name}' (${profileId}) to device ${deviceId_}`);
  // F3 instant apply (M2C-B) + M2C-C routing/elevation: ONE attempt, shared
  // with the UI apply path. A non-elevated parent delegates to the elevated
  // self-worker; the boot task runs elevated and applies in-process.
  // M4-D (PERMANENT acceptance): a waiver-not-set answer with a persisted
  // acceptance gets exactly ONE silent re-set + retry (mirror runApply) -
  // the M4-D boot probe that restores the driver waiver runs only in the
  // window path, so the logon/tray apply must honor the permanent consent
  // itself instead of restoring defaults over a stale driver waiver.
  const attempt = async (waiverAccepted) => {
    if (applyRunner?.needsWorker?.()) {
      // S2: the runner request carries the device-side waiver state so the
      // worker's in-memory flag matches what the user accepted. M3-C-E: it
      // carries the persisted ocMode so the worker's gate keys on the real
      // mode (its own caps always report extendedRanges). M4O: it carries
      // profileApply:true so the worker skips the STOCK gate (the profile
      // is the user's own deliberate state) while keeping the ceiling
      // refusal (>315 W never silently clamps).
      return applyRunner.apply({
        deviceId: deviceId_,
        settings: profile.settings,
        profileName: profile.name,
        waiverAccepted,
        ocMode: settings.ocMode,
        profileApply: true,
      });
    }
    // M4O: opts.profileApply:true - executeApply clamps against the
    // driver's TRUE limits (extendedRangesFor) instead of the mode-gated
    // caps.ranges (stock max 252 would silently reduce a saved 300 W
    // profile) and keys its safety-net capability refusal on the runtime
    // probe (oldIgcl.isCapable) instead of caps.extendedRanges.
    return executeApply({ backend, oldIgcl, deviceId: deviceId_, settings: profile.settings, log, opts: { profileApply: true } });
  };
  let result;
  let state = null;
  try {
    let out = await attempt(caps.waiverAccepted === true);
    result = out.result;
    state = out.state;
    // M4-D: the apply answered waiver-not-set while the persisted acceptance
    // is true (settings.json - the user's permanent consent). Silently
    // re-set the driver waiver (in-process on the elevated boot task;
    // runner.waiverAccept on the tray path) and retry the apply ONCE. A
    // declined/unavailable re-set falls through to the honest failure path
    // (never a fake success). Exactly one retry - a second waiver-not-set
    // lands in the defaults restore below, never an endless loop.
    if (!result.ok && hasWaiverNotSet(result) && settings.waiverAccepted === true) {
      log('[apply-on-boot] apply answered waiver-not-set with a persisted acceptance - silently re-setting the driver waiver and retrying ONCE');
      try {
        if (applyRunner?.needsWorker?.()) {
          await applyRunner.waiverAccept(deviceId_);
          await backend.restoreWaiverState(deviceId_, true);
        } else {
          await backend.setWaiverAccepted(deviceId_);
        }
        out = await attempt(true);
        result = out.result;
        state = out.state;
      } catch (err) {
        log(`[apply-on-boot] waiver re-set failed: ${err.message} - falling through to the honest failure path`);
      }
    }
    log(`[apply-on-boot] attempt(s) completed with ${Object.keys(result.perControl).length} per-control result(s)`);
  } catch (err) {
    return { applied: false, reason: `apply threw: ${err.message}` };
  }
  if (!state) {
    try {
      state = await backend.getCurrentSettings(deviceId_);
    } catch {
      // Read-back failure (M2b step-5 NIT 5): degrade to a null state - the
      // outcome is still reported from `result`; never crash the flow.
    }
  }

  if (result.ok === true) {
    log(`[apply-on-boot] applied and read-back verified: ${JSON.stringify(result.perControl)}`);
    return { applied: true, result, state };
  }

  // Failure -> defaults, never a silent partial apply. Reached either by a
  // non-waiver failure or by the M4-D retry also failing (the retry ran
  // exactly once above - a second waiver-not-set lands here honestly).
  //
  // M4M (F5): the in-app boot apply runs applyRunner-less (in-process ONLY -
  // NEVER the elevated worker, NEVER a UAC at logon). The packaged app is
  // ALWAYS elevated (requireAdministrator - the "unelevated" M4-D2 framing
  // is stale since 1.0.4), so the in-process apply persists on the product
  // path; only the dev tree can be unelevated. The fallback-skip is keyed
  // on the SESSION (skipDefaultsFallback), REGARDLESS of errorCode: an
  // app-start apply must NEVER wipe the live OC state over a failure (an
  // elevation refusal in dev, a driver refusal in the product). The honest
  // balloon is the caller's job; the ELEVATED logon applies come from the
  // ArcPowerBootApply task (--boot-apply mode, M4-E).
  if (skipDefaultsFallback) {
    log('[apply-on-boot] boot variant (applyRunner-less, in-process): apply failed - defaults-restore fallback SKIPPED (an app-start apply must never wipe live OC state over a failure; logon applies run elevated via the ArcPowerBootApply task)');
    return {
      applied: false,
      reason: 'apply failed; defaults restore skipped (app-start applies never restore defaults)',
      result,
      state,
      fallbackSkipped: true,
    };
  }
  log(`[apply-on-boot] apply failed: ${JSON.stringify(result.perControl)} - restoring defaults`);
  let fallbackApplied = true;
  try {
    if (applyRunner?.needsWorker?.()) {
      const out = await applyRunner.reset(deviceId_);
      if (!out.ok) throw new Error('reset via elevated worker failed');
    } else {
      await backend.resetToDefaults(deviceId_);
    }
  } catch (err) {
    fallbackApplied = false;
    log(`[apply-on-boot] defaults restore FAILED: ${err.message}`);
  }
  let afterFallback = null;
  try {
    afterFallback = await backend.getCurrentSettings(deviceId_);
  } catch {
    // Read-back failure (M2b step-5 NIT 5): degrade to a null state - the
    // fallback flag + reason still report the outcome.
  }
  return {
    applied: false,
    reason: 'apply failed; defaults restored',
    fallbackApplied,
    result,
    state: afterFallback,
  };
}

/**
 * Boot-gated variant (`--apply-profile`): additionally requires ocOnBoot.
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   store: import('./store/profile-store.js').ProfileStore,
 *   profileId: string,
 *   deviceId?: number | null,   // M4-F: explicit target (default: persisted ?? devices[0])
 *   log?: (s: string) => void,
 *   oldIgcl?: object,
 *   applyRunner?: object | null,
 * }} ctx
 * @returns {Promise<{
 *   applied: boolean,
 *   reason: string,
 *   fallbackApplied?: boolean,
 *   result?: unknown,
 *   state?: unknown,
 * }>}
 */
export async function applyProfileOnBoot({ backend, store, profileId, deviceId = null, log = () => {}, oldIgcl = null, applyRunner = null }) {
  return applyProfile({ backend, store, profileId, deviceId, log, requireOcOnBoot: true, oldIgcl, applyRunner });
}

/**
 * M4M (F5): the IN-APP boot variant (window path - the app launched from
 * the HKCU Run value). Runs the boot-gated shared flow with applyRunner:
 * null (in-process ONLY - NEVER the elevated worker, no UAC at logon) and
 * the defaults-restore fallback SKIPPED regardless of errorCode (an
 * app-start apply must never wipe the live OC state over a failure - the
 * packaged app is always elevated, only the dev tree can be unelevated).
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   store: import('./store/profile-store.js').ProfileStore,
 *   profileId: string,
 *   deviceId?: number | null,   // M4-F: explicit target (default: persisted ?? devices[0])
 *   log?: (s: string) => void,
 *   oldIgcl?: object,
 * }} ctx
 * @returns {Promise<{
 *   applied: boolean,
 *   reason: string,
 *   fallbackSkipped?: boolean,
 *   result?: unknown,
 *   state?: unknown,
 * }>}
 */
export async function applyProfileBoot({ backend, store, profileId, deviceId = null, log = () => {}, oldIgcl = null }) {
  return applyProfile({
    backend, store, profileId, deviceId, log,
    requireOcOnBoot: true,
    oldIgcl,
    applyRunner: null,
    skipDefaultsFallback: true,
  });
}

/**
 * M2b `--apply-profile <id>` CLI flow (no window, tray only). Runs the
 * boot-gated apply and owns the tray lifecycle: exactly ONE tray is created
 * (it keeps the app alive in this mode) and reused for the outcome balloon -
 * never two Tray instances (M2b review F2). The balloon claims "defaults
 * restored" ONLY when a restore actually ran (fallbackApplied !== undefined);
 * gate refusals balloon too, with the same reason-specific messages as the
 * tray click path (M2b step-5 NIT 1) - never a false "defaults restored".
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   store: import('./store/profile-store.js').ProfileStore,
 *   profileId: string,
 *   deviceId?: number | null,   // M4-F: explicit target (default: persisted ?? devices[0])
 *   setupTray: () => Promise<{ displayBalloon: (o: { title: string, content: string }) => void }>,
 *   log?: (s: string) => void,
 *   oldIgcl?: object,
 * }} ctx
 * @returns {Promise<{
 *   applied: boolean,
 *   reason: string,
 *   fallbackApplied?: boolean,
 *   result?: unknown,
 *   state?: unknown,
 * }>}
 */
export async function runApplyOnStartup({ backend, store, profileId, deviceId = null, setupTray, log = () => {}, oldIgcl = null }) {
  let out;
  try {
    out = await applyProfileOnBoot({ backend, store, profileId, deviceId, log, oldIgcl });
  } catch (err) {
    out = { applied: false, reason: err.message };
  }
  const tray = await setupTray();
  if (out.applied) {
    log(`[apply-on-boot] applied profile '${profileId}'`);
    return out;
  }
  log(`[apply-on-boot] NOT applied: ${out.reason}`);
  // NIT 1: refusal outcomes balloon on the boot path too (the tray exists) -
  // same reason-specific messages as the tray click path (main.js); the
  // balloon never claims "defaults restored" unless a restore actually ran.
  const profiles = await store.loadProfiles().catch(() => []);
  const name = (profiles.find((p) => p.id === profileId) ?? {}).name ?? profileId;
  const content = trayBalloonForOutcome(out, name);
  if (content) {
    try {
      tray.displayBalloon({ title: TRAY_BALLOON_TITLE, content });
    } catch {
      // tray may be unavailable in some sessions
    }
    log(`[apply-on-boot] tray balloon sent: ${content}`);
  }
  return out;
}
