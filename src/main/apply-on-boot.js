// Arc Power — M2b/M2C-C apply-on-startup flow (`--apply-profile <id>`) and
// the shared profile-apply flow (tray "Apply active profile").
//
// Electron-free so the whole flow is testable under plain `node --test`
// with MockBackend. Gates: the persisted settings must have waiverAccepted
// (the waiver must also be accepted on the device — seedWaiverState runs
// before this at boot). The ocOnBoot gate applies ONLY to the boot path:
// an explicit user action (tray click, renderer Load) skips it but keeps
// the waiver gates. Applies the profile with read-back verification (the
// backend's per-control read-back + the routing layer's delayed re-read);
// on failure applies defaults (resetToDefaults) and reports the fallback —
// never a silent partial apply. The "defaults restored" claim is only ever
// made when a restore actually ran (fallbackApplied !== undefined).
//
// M2C-C: the apply goes through the ROUTED core (DriverStore runtime for
// values within range, bundled 2023 runtime above 252 W / 90 C) and through
// the elevation-aware apply runner — the boot task runs elevated (/rl
// highest), so its runner applies in-process; a manually-launched
// non-elevated instance fails honestly per control.

import { TRAY_BALLOON_TITLE, trayBalloonForOutcome } from './tray.js';
import { executeApply, ocModeRefusal, extendedUnavailableRefusal } from './apply-routing.js';

/**
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   store: import('./store/profile-store.js').ProfileStore,
 *   profileId: string,
 *   log?: (s: string) => void,
 *   requireOcOnBoot?: boolean,   // boot path only; explicit actions skip it
 *   oldIgcl?: object,            // M2C-C: bundled-2023-runtime adapter (null in tests that never extend)
 *   applyRunner?: object | null, // M2C-C: elevation-aware apply runner (null = in-process)
 * }} ctx
 * @returns {Promise<{
 *   applied: boolean,
 *   reason: string,
 *   fallbackApplied?: boolean,
 *   result?: unknown,
 *   state?: unknown,
 * }>}
 */
export async function applyProfile({ backend, store, profileId, log = () => {}, requireOcOnBoot = false, oldIgcl = null, applyRunner = null }) {
  const settings = await store.loadSettings();
  if (requireOcOnBoot && settings.ocOnBoot !== true) {
    return { applied: false, reason: 'Start-at-boot is disabled' };
  }
  if (settings.waiverAccepted !== true) {
    return { applied: false, reason: 'Waiver not accepted' };
  }

  let devices;
  try {
    devices = await backend.listDevices();
  } catch (err) {
    return { applied: false, reason: `device enumeration failed: ${err.message}` };
  }
  if (devices.length === 0) {
    return { applied: false, reason: 'no devices enumerated' };
  }
  const deviceId = devices[0].id;

  let caps;
  try {
    caps = await backend.getCapabilities(deviceId);
  } catch (err) {
    return { applied: false, reason: `capability query failed: ${err.message}` };
  }
  if (caps.waiverAccepted !== true) {
    // The driver lost the waiver since the last session — never auto-accept.
    return { applied: false, reason: 'waiver not accepted on the device' };
  }

  const profiles = await store.loadProfiles();
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) {
    return { applied: false, reason: `profile '${profileId}' not found` };
  }

  // M3-C-E: the OC-mode gate runs BEFORE any apply (and before the clamp).
  // A mode refusal is a CONFIG refusal, not a hardware failure: it reports
  // the mode message ONLY and NEVER runs the reset-to-defaults fallback —
  // a saved 300 W profile applied at every logon in stock mode must refuse
  // cleanly, never wipe the live OC state and never balloon "defaults
  // restored" (fallbackApplied stays undefined -> the tray shows the
  // reason-specific refused balloon). Same for the tray path (shared flow).
  const refusal = ocModeRefusal(settings.ocMode, profile.settings);
  if (refusal) {
    log(`[apply-on-boot] oc-mode refusal (${refusal.mode}): ${refusal.message} (${refusal.controls.join(', ')}) — nothing applied, NO defaults restore`);
    return { applied: false, reason: refusal.message, ocModeRefused: true };
  }

  // M3-C step-5 F1: advanced mode + a NOT-capable bundled 2023 runtime (the
  // future-driver degradation) -> refuse the profile's extended values
  // BEFORE any apply, never a silent 252 W / 90 C clamp reported as applied.
  // Same refusal classification as the mode gate: no defaults-restore
  // fallback, the live OC state survives, and the tray balloon is the
  // reason-specific refusal (fallbackApplied stays undefined). Keyed on the
  // capability (caps.extendedRanges), never the mode — identical probe on
  // both sides of the worker boundary.
  const unavailable = extendedUnavailableRefusal(profile.settings, caps);
  if (unavailable) {
    log(`[apply-on-boot] extended-unavailable refusal: ${unavailable.message} (${unavailable.controls.join(', ')}) — nothing applied, NO defaults restore`);
    return { applied: false, reason: unavailable.message, extendedUnavailable: true };
  }

  log(`[apply-on-boot] applying profile '${profile.name}' (${profileId}) to device ${deviceId} — single attempt`);
  // F3 instant apply (M2C-B) + M2C-C routing/elevation: ONE attempt, shared
  // with the UI apply path. A non-elevated parent delegates to the elevated
  // self-worker; the boot task runs elevated and applies in-process.
  let result;
  let state = null;
  try {
    if (applyRunner?.needsWorker?.()) {
      // S2: the runner request carries the device-side waiver state so the
      // worker's in-memory flag matches what the user accepted. M3-C-E: it
      // carries the persisted ocMode so the worker's gate keys on the real
      // mode (its own caps always report extendedRanges).
      const out = await applyRunner.apply({
        deviceId,
        settings: profile.settings,
        profileName: profile.name,
        waiverAccepted: caps.waiverAccepted === true,
        ocMode: settings.ocMode,
      });
      result = out.result;
      state = out.state;
    } else {
      const out = await executeApply({ backend, oldIgcl, deviceId, settings: profile.settings, log });
      result = out.result;
      state = out.state;
    }
    log(`[apply-on-boot] single attempt completed with ${Object.keys(result.perControl).length} per-control result(s)`);
  } catch (err) {
    return { applied: false, reason: `apply threw: ${err.message}` };
  }
  if (!state) {
    try {
      state = await backend.getCurrentSettings(deviceId);
    } catch {
      // Read-back failure (M2b step-5 NIT 5): degrade to a null state — the
      // outcome is still reported from `result`; never crash the flow.
    }
  }

  if (result.ok === true) {
    log(`[apply-on-boot] applied and read-back verified: ${JSON.stringify(result.perControl)}`);
    return { applied: true, result, state };
  }

  // Failure -> defaults, never a silent partial apply.
  log(`[apply-on-boot] apply failed: ${JSON.stringify(result.perControl)} — restoring defaults`);
  let fallbackApplied = true;
  try {
    if (applyRunner?.needsWorker?.()) {
      const out = await applyRunner.reset(deviceId);
      if (!out.ok) throw new Error('reset via elevated worker failed');
    } else {
      await backend.resetToDefaults(deviceId);
    }
  } catch (err) {
    fallbackApplied = false;
    log(`[apply-on-boot] defaults restore FAILED: ${err.message}`);
  }
  let afterFallback = null;
  try {
    afterFallback = await backend.getCurrentSettings(deviceId);
  } catch {
    // Read-back failure (M2b step-5 NIT 5): degrade to a null state — the
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
export async function applyProfileOnBoot({ backend, store, profileId, log = () => {}, oldIgcl = null, applyRunner = null }) {
  return applyProfile({ backend, store, profileId, log, requireOcOnBoot: true, oldIgcl, applyRunner });
}

/**
 * M2b `--apply-profile <id>` CLI flow (no window, tray only). Runs the
 * boot-gated apply and owns the tray lifecycle: exactly ONE tray is created
 * (it keeps the app alive in this mode) and reused for the outcome balloon —
 * never two Tray instances (M2b review F2). The balloon claims "defaults
 * restored" ONLY when a restore actually ran (fallbackApplied !== undefined);
 * gate refusals balloon too, with the same reason-specific messages as the
 * tray click path (M2b step-5 NIT 1) — never a false "defaults restored".
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   store: import('./store/profile-store.js').ProfileStore,
 *   profileId: string,
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
export async function runApplyOnStartup({ backend, store, profileId, setupTray, log = () => {}, oldIgcl = null }) {
  let out;
  try {
    out = await applyProfileOnBoot({ backend, store, profileId, log, oldIgcl });
  } catch (err) {
    out = { applied: false, reason: err.message };
  }
  const tray = await setupTray();
  if (out.applied) {
    log(`[apply-on-boot] applied profile '${profileId}'`);
    return out;
  }
  log(`[apply-on-boot] NOT applied: ${out.reason}`);
  // NIT 1: refusal outcomes balloon on the boot path too (the tray exists) —
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
