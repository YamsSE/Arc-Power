// Arc Power — M2b apply-on-startup flow (`--apply-profile <id>`) and the
// shared profile-apply flow (tray "Apply active profile").
//
// Electron-free so the whole flow is testable under plain `node --test`
// with MockBackend. Gates: the persisted settings must have waiverAccepted
// (the waiver must also be accepted on the device — seedWaiverState runs
// before this at boot). The ocOnBoot gate applies ONLY to the boot path:
// an explicit user action (tray click, renderer Load) skips it but keeps
// the waiver gates. Applies the profile with read-back verification (the
// backend's per-control read-back); on failure applies defaults
// (resetToDefaults) and reports the fallback — never a silent partial
// apply. The "defaults restored" claim is only ever made when a restore
// actually ran (fallbackApplied !== undefined).

import { TRAY_BALLOON_TITLE, trayBalloonForOutcome } from './tray.js';
import { applyWithRetry, APPLY_BUDGET_MS, APPLY_BUDGET_MS_BOOT } from './apply-retry.js';

/**
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   store: import('./store/profile-store.js').ProfileStore,
 *   profileId: string,
 *   log?: (s: string) => void,
 *   requireOcOnBoot?: boolean,   // boot path only; explicit actions skip it
 *   budgetMs?: number,           // apply retry budget (boot: 20 s; tray/UI: 60 s)
 *   getIgsState?: () => Promise<{ service: { running: boolean }, appRunning: boolean }>,
 * }} ctx
 * @returns {Promise<{
 *   applied: boolean,
 *   reason: string,
 *   fallbackApplied?: boolean,
 *   result?: unknown,
 *   state?: unknown,
 * }>}
 */
export async function applyProfile({ backend, store, profileId, log = () => {}, requireOcOnBoot = false, budgetMs = APPLY_BUDGET_MS, getIgsState = null }) {
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

  log(`[apply-on-boot] applying profile '${profile.name}' (${profileId}) to device ${deviceId} (retry budget ${budgetMs} ms)`);
  // F3 retry-with-verify: shared with the UI apply path. Boot/tray applies
  // get the same patient, honest treatment; the boot path caps its budget
  // (20 s) so boot is never blocked indefinitely, and the IGS fully-on fast
  // path (single attempt) applies whenever the probe reports it.
  let igsState = null;
  if (getIgsState) {
    try { igsState = await getIgsState(); } catch { /* degraded probe -> retries enabled */ }
  }
  let result;
  try {
    const out = await applyWithRetry({
      backend,
      deviceId,
      settings: profile.settings,
      opts: { budgetMs, igsState },
      onProgress: (p) => log(`[apply-on-boot] attempt ${p.attempt}/${p.retryOf} for [${p.controls.join(', ')}] (${p.elapsedMs} ms elapsed)`),
    });
    result = out.result;
    if (out.gaveUp) log(`[apply-on-boot] gave up after ${out.attempts} attempt(s) within the ${budgetMs} ms budget`);
    if (out.cancelled) log(`[apply-on-boot] apply cancelled`);
  } catch (err) {
    return { applied: false, reason: `apply threw: ${err.message}` };
  }
  let state = null;
  try {
    state = await backend.getCurrentSettings(deviceId);
  } catch {
    // Read-back failure (M2b step-5 NIT 5): degrade to a null state — the
    // outcome is still reported from `result`; never crash the flow.
  }

  if (result.ok === true) {
    log(`[apply-on-boot] applied and read-back verified: ${JSON.stringify(result.perControl)}`);
    return { applied: true, result, state };
  }

  // Failure -> defaults, never a silent partial apply.
  log(`[apply-on-boot] apply failed: ${JSON.stringify(result.perControl)} — restoring defaults`);
  let fallbackApplied = true;
  try {
    await backend.resetToDefaults(deviceId);
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
 * The retry budget is capped at 20 s so boot is never blocked indefinitely
 * (`budgetMs` injectable for tests / the acceptance harness).
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   store: import('./store/profile-store.js').ProfileStore,
 *   profileId: string,
 *   log?: (s: string) => void,
 *   budgetMs?: number,
 *   getIgsState?: () => Promise<{ service: { running: boolean }, appRunning: boolean }>,
 * }} ctx
 * @returns {Promise<{
 *   applied: boolean,
 *   reason: string,
 *   fallbackApplied?: boolean,
 *   result?: unknown,
 *   state?: unknown,
 * }>}
 */
export async function applyProfileOnBoot({ backend, store, profileId, log = () => {}, budgetMs = APPLY_BUDGET_MS_BOOT, getIgsState = null }) {
  return applyProfile({ backend, store, profileId, log, requireOcOnBoot: true, budgetMs, getIgsState });
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
 *   budgetMs?: number,
 *   getIgsState?: () => Promise<{ service: { running: boolean }, appRunning: boolean }>,
 * }} ctx
 * @returns {Promise<{
 *   applied: boolean,
 *   reason: string,
 *   fallbackApplied?: boolean,
 *   result?: unknown,
 *   state?: unknown,
 * }>}
 */
export async function runApplyOnStartup({ backend, store, profileId, setupTray, log = () => {}, budgetMs = APPLY_BUDGET_MS_BOOT, getIgsState = null }) {
  let out;
  try {
    out = await applyProfileOnBoot({ backend, store, profileId, log, budgetMs, getIgsState });
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
