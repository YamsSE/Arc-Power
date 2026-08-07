// Arc Power — IPC handlers factory + payload validation (the security
// surface). Kept electron-free so the whole contract is unit-testable under
// plain `node --test` (no electron import). Registration over ipcMain lives
// in ipc.js.
//
// Contract:
//   - deviceId is a non-negative integer, validated on every handler;
//   - apply-settings payload: plain object, keys ⊆ CONTROLS, values finite
//     numbers / well-formed arrays or objects — anything else is rejected
//     before it can reach the backend;
//   - apply-settings re-clamps scalar values against the device's capability
//     ranges in main (product applies snap to the capability step);
//   - after apply/reset the current settings are always re-read (IGS may
//     have changed OC state between runs) and returned to the caller;
//   - telemetry is owned by main (one TelemetryService per device), pushed
//     to the renderer via the injected `emit`;
//   - the waiver is NEVER auto-accepted here: waiver-accept is the only path
//     to setWaiverAccepted, and it is called by the renderer only after the
//     user explicitly accepted the dialog.

import { createRequire } from 'node:module';
import { TelemetryService } from './telemetry/telemetry-service.js';
import { collectHealth } from './health.js';
import { CONTROLS } from './backend/backend.interface.js';
import { clampAndSnap, clampGpuLock, nearlyEqual } from './backend/units.js';
import { REGISTRY_CATALOG, createMockRegistryCatalog, createMockRegistryState } from './registry-catalog.js';
import { createMockRegistryApply } from './registry-apply.js';
import { createMockStartup } from './startup.js';
import { createMockDriverInfo } from './driver-info.js';
import { executeApply, createNullOldIgcl, ocModeRefusal, refusalPerControl, extendedUnavailableRefusal, extendedUnavailablePerControl, OC_MODES } from './apply-routing.js';
import { isElevated as detectElevated } from './elevation.js';

const require = createRequire(import.meta.url);
// The app version shipped to the renderer for the header line (B3); the
// product path injects app.getVersion() from ipc.js — this is the default
// when no electron app exists (tests).
const PKG_VERSION = require('../../package.json').version ?? '0.0.0';

const SCALAR_CONTROLS = new Set([
  'powerLimitW', 'gpuVoltOffsetV', 'gpuFreqOffsetMhz', 'tempLimitC',
  'vramFreqOffsetGts', 'vramVoltOffsetV', 'fixedFanPct',
]);
const FAN_MODES = new Set(['auto', 'curve', 'fixed']);
// ctl_fan_speed_table_t.table size — must match pure/curve.ts MAX_CURVE_POINTS.
const MAX_CURVE_POINTS = 32;
// Reset read-back tolerance (canonical units; a reset must land on the
// capability default within this).
const RESET_VERIFY_EPS = 1e-6;

/**
 * @param {unknown} v
 * @returns {number}
 */
export function assertValidDeviceId(v) {
  if (!Number.isInteger(v) || v < 0) {
    throw new Error(`invalid device id: ${JSON.stringify(v)}`);
  }
  return v;
}

/**
 * Validate an apply-settings payload and return a clean copy. Throws on
 * anything that is not a legal Settings object (unknown keys, NaN,
 * malformed arrays/objects).
 * @param {unknown} payload
 * @returns {import('./backend/backend.interface.js').Settings}
 */
export function sanitizeSettings(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('apply-settings payload must be a plain object');
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!CONTROLS.includes(key)) throw new Error(`unknown control: ${key}`);
    if (SCALAR_CONTROLS.has(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${key} must be a finite number`);
      }
      out[key] = value;
    } else if (key === 'fanMode') {
      if (!FAN_MODES.has(value)) throw new Error(`fanMode must be one of: auto, curve, fixed`);
      out[key] = value;
    } else if (key === 'gpuLock') {
      if (typeof value !== 'object' || value === null
        || !Number.isFinite(value.voltageV) || !Number.isFinite(value.freqMhz)) {
        throw new Error('gpuLock must be { voltageV: number, freqMhz: number }');
      }
      out[key] = { voltageV: value.voltageV, freqMhz: value.freqMhz };
    } else if (key === 'vfCurve' || key === 'fanCurve') {
      if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CURVE_POINTS) {
        throw new Error(`${key} must be a non-empty array of at most ${MAX_CURVE_POINTS} points`);
      }
      const fields = key === 'vfCurve' ? ['voltageV', 'freqMhz'] : ['t', 'speedPct'];
      out[key] = value.map((pt) => {
        if (typeof pt !== 'object' || pt === null || fields.some((f) => !Number.isFinite(pt[f]))) {
          throw new Error(`${key} points must be objects with finite ${fields.join(', ')}`);
        }
        /** @type {Record<string, number>} */
        const clean = {};
        for (const f of fields) clean[f] = pt[f];
        return clean;
      });
    }
  }
  return out;
}

/**
 * Re-clamp scalar settings against the device capability ranges (snap to
 * the capability step). Non-scalar controls pass through — the backend
 * gates them itself; gpuLock is clamped to the documented lock bounds
 * (clampGpuLock) so an extreme pair never reaches the driver.
 * @param {import('./backend/backend.interface.js').Settings} settings
 * @param {Record<string, { min: number, max: number, step: number, default: number, units: string }>} ranges
 * @returns {import('./backend/backend.interface.js').Settings}
 */
export function clampSettings(settings, ranges) {
  const out = { ...settings };
  for (const key of Object.keys(out)) {
    const range = ranges[key];
    if (range && SCALAR_CONTROLS.has(key) && typeof out[key] === 'number') {
      out[key] = clampAndSnap(out[key], range);
    }
  }
  if (out.gpuLock) out.gpuLock = clampGpuLock(out.gpuLock);
  return out;
}

/**
 * Boot-time waiver seeding (F1): restore a persisted acceptance (settings.json
 * written by waiver-accept) into the backend's IN-MEMORY flag WITHOUT calling
 * the driver — ctlOverclockWaiverSet must only run on explicit user
 * acceptance, so this never implicitly accepts. A store read failure degrades
 * to not-accepted (the waiver dialog re-shows on the next apply — safe).
 * Call once after backend.init() before the renderer boots.
 * @param {import('./backend/backend.interface.js').IOCBackend} backend
 * @param {import('./store/profile-store.js').ProfileStore} store
 */
export async function seedWaiverState(backend, store) {
  const devices = await backend.listDevices();
  let accepted = false;
  try {
    accepted = (await store.loadSettings()).waiverAccepted === true;
  } catch {
    // degraded: treat as not accepted — never a false "accepted"
  }
  for (const device of devices) {
    await backend.restoreWaiverState(device.id, accepted);
  }
}

/**
 * M3-C review F3: seed the backend's OC mode from the persisted settings
 * (settings.json via the store). Must run BEFORE the window/IPC exist — the
 * renderer's FIRST getCapabilities must already see the right range set (a
 * persisted-advanced session must never render 252 W / 90 C sliders until a
 * later self-heal). setOcMode is an in-memory caps-cache invalidation, safe
 * before init(). Returns the seeded mode, or null when the store read fails
 * (degraded: the backend keeps its construction default — bootBackend's own
 * seeding runs again later, and the mode toggle re-seeds on demand).
 * @param {import('./backend/backend.interface.js').IOCBackend} backend
 * @param {import('./store/profile-store.js').ProfileStore} store
 * @returns {Promise<'stock'|'advanced'|null>}
 */
export async function seedOcMode(backend, store) {
  try {
    const s = await store.loadSettings();
    if (typeof backend.setOcMode === 'function') backend.setOcMode(s.ocMode);
    return s.ocMode;
  } catch {
    return null;
  }
}

/**
 * Channels that take no payload must never receive one (the preload only
 * calls them bare, but the whitelist is the enforcement point).
 */
export function assertNoPayload(args, channel) {
  if (args.length > 0) {
    throw new Error(`${channel} takes no payload`);
  }
}

/**
 * Build the handler map for every whitelisted channel.
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   store: import('./store/profile-store.js').ProfileStore,
 *   emit: (channel: string, payload: unknown) => void,
 *   startup?: { get: () => Promise<unknown>, set: (enabled: boolean, profileId: string | null) => Promise<unknown> },
 *   driverInfo?: { get: () => Promise<{ driverDate: string | null }> },
 *   registryCatalog?: { get: () => Promise<unknown> },  // M3-A read-side catalog
 *   registryApply?: { apply: (entryId: string, action: string) => Promise<unknown> },  // M3-B elevated apply
 *   presentmon?: { poll: (deviceId: number) => Promise<{ fps: number | null, frameTimeMs: number | null, gpuBusy: number | null } | null> },
 *   rebuildTray?: () => Promise<unknown>,
 *   appVersion?: string,
 *   oldIgcl?: object,            // bundled-2023-runtime adapter (apply-routing)
 *   applyRunner?: object|null,   // elevation-aware apply runner (elevated-apply)
 *   isElevated?: () => boolean,  // elevation probe for the app-elevated channel
 *   mock?: {                     // M2D: mock-only featureset control. When null
 *                                // (real mode) the mock:* channels are NOT
 *                                // registered at all — an honest 404.
 *     listFeaturesets: () => Promise<{ featuresets: Array<{id: string, name: string, tag: string}>, current: string }>,
 *     setFeatureset: (id: string) => Promise<{ featureset: object, devices: object[], caps: object, state: object, health: object, driverDate: string | null }>,
 *   } | null,
 * }} ctx
 */
export function createIpcHandlers({
  backend,
  store,
  emit,
  startup = createMockStartup(),
  driverInfo = createMockDriverInfo(),
  // M3-A: the registry-catalog adapter. The DEFAULT is the MOCK (never runs
  // reg.exe); ipc.js injects the real adapter in the product path. The
  // catalog is read-side only — the M3-B apply channel is 'registry-apply'.
  registryCatalog,
  // M3-B: the registry-apply adapter. The DEFAULT is the MOCK (never spawns
  // PowerShell, never elevates); ipc.js injects the real adapter in the
  // product path. The mock catalog + mock apply SHARE one mock registry
  // state so an applied action is honestly reflected by the next
  // registry-catalog read (the post-apply state refresh).
  registryApply,
  // M2b-B: the FPS adapter. The DEFAULT is the mock (always unavailable —
  // never loads koffi/PresentMonAPI2); ipc.js injects the real client in the
  // product path. On this machine the real client degrades to null anyway
  // (no PresentMon service), so mock and product agree on 'unavailable'.
  presentmon = { poll: async () => null },
  rebuildTray = async () => {},
  appVersion = PKG_VERSION,
  // M2C-C: the 2023-runtime adapter + the elevation-aware apply runner.
  // Defaults: a no-op old runtime (never loads the DLL) and no runner
  // (applies run in-process) — safe for tests and mock mode.
  oldIgcl = createNullOldIgcl(),
  applyRunner = null,
  isElevated = detectElevated,
  mock = null,
}) {
  // M3-A/M3-B mock defaults: the read + apply mock adapters share ONE mock
  // registry state (in-memory; never touches the real registry), so a mock
  // apply flips the very next mock read. When either adapter is injected,
  // both are product/real or test-injected — a shared state is only built
  // for the default pair.
  const mockRegistryState = registryCatalog && registryApply ? null : createMockRegistryState();
  const catalogAdapter = registryCatalog ?? createMockRegistryCatalog(REGISTRY_CATALOG, { state: mockRegistryState });
  const registryApplyAdapter = registryApply ?? createMockRegistryApply(REGISTRY_CATALOG, { state: mockRegistryState });
  /** @type {Map<number, TelemetryService>} */
  const telemetry = new Map();

  const startTelemetry = async (deviceId) => {
    if (telemetry.has(deviceId)) return;
    const svc = new TelemetryService(backend, deviceId);
    svc.onSample((sample) => emit('telemetry:sample', sample));
    svc.onPollError(() => { /* stale readouts recover on the next tick */ });
    await svc.start();
    telemetry.set(deviceId, svc);
  };

  const stopAllTelemetry = async () => {
    for (const svc of telemetry.values()) {
      try { await svc.stop(); } catch { /* best effort */ }
    }
    telemetry.clear();
  };

  const handlers = {
    'health': async () => collectHealth(backend),

      'list-devices': async () => backend.listDevices(),

      'get-capabilities': async (deviceId) => {
        assertValidDeviceId(deviceId);
        return backend.getCapabilities(deviceId);
      },

      'get-current-settings': async (deviceId) => {
        assertValidDeviceId(deviceId);
        return backend.getCurrentSettings(deviceId);
      },

      'apply-settings': async (deviceId, payload) => {
        assertValidDeviceId(deviceId);
        const settings = sanitizeSettings(payload);
        // M3-C-E: the OC-mode gate runs BEFORE every clamp — an explicit
        // pre-clamp REFUSAL, never a clamp. Stock mode refuses anything
        // beyond the standard limits (252 W / 90 C) with the mode message;
        // advanced mode refuses only above the extended ceiling (315 W /
        // 115 C — never clamps, so a >315 W request is reported honestly).
        // A config-refusal is NOT a hardware failure: it must never trigger
        // the reset-to-defaults fallback anywhere downstream.
        const ocMode = (await store.loadSettings()).ocMode;
        const refusal = ocModeRefusal(ocMode, settings);
        if (refusal) {
          // M3-C review F2: the refusal envelope carries the FRESH device
          // state (getCurrentSettings is cheap — the refusal never touched
          // the GPU). A null state would be stored by the renderer
          // unconditionally and null out its device state (the OC page
          // renders 'Loading device capabilities…' forever and the dirty
          // helpers throw on it). Degraded to null only if the read itself
          // fails — the renderer's non-null guard covers that too.
          let state = null;
          try { state = await backend.getCurrentSettings(deviceId); } catch { /* degraded */ }
          return { result: { ok: false, perControl: refusalPerControl(refusal) }, state, ocModeRefused: true };
        }
        const caps = await backend.getCapabilities(deviceId);
        // M3-C step-5 F1: advanced mode + a NOT-capable bundled 2023 runtime
        // (the future-driver degradation EXTENDED_UNAVAILABLE_MSG exists
        // for) must refuse extended values BEFORE any clamp — clamping
        // 300 W to 252 W and reporting ok:true would be a false success
        // claim. Keyed on caps.extendedRanges (the capability probe is
        // identical on both sides of the worker boundary), never on the
        // mode. Same refusal envelope as the mode gate: fresh state, never
        // a defaults-restore downstream.
        const unavailable = extendedUnavailableRefusal(settings, caps);
        if (unavailable) {
          let state = null;
          try { state = await backend.getCurrentSettings(deviceId); } catch { /* degraded */ }
          return { result: { ok: false, perControl: extendedUnavailablePerControl(unavailable.controls) }, state, extendedUnavailable: true };
        }
        const clamped = clampSettings(settings, caps.ranges);
        // M2C-C elevation gate: a non-elevated app delegates the apply to
        // the elevated self-worker (one UAC prompt); the elevated app (and
        // mock mode, where applyRunner is null) applies in-process through
        // the routed core (DriverStore runtime <=252 W / <=90 C, bundled
        // 2023 runtime above). The worker runs the SAME core + gate (the
        // request file carries ocMode — the worker's own caps always report
        // extendedRanges, so a caps-keyed gate there would silently clamp).
        if (applyRunner?.needsWorker?.()) {
          // S2: the request carries the parent-side waiver flag so the
          // worker's in-memory state (its clamp caps + apply gate) matches
          // what the user already accepted.
          const out = await applyRunner.apply({
            deviceId,
            settings: clamped,
            waiverAccepted: caps.waiverAccepted === true,
            ocMode,
          });
          // S2 G2 mirror: when the driver lost the waiver, the worker's
          // per-control results carry waiver-not-set. Clear the parent-side
          // in-memory flag so the next getCapabilities reports unaccepted
          // and the waiver dialog re-shows — the wedge (stale-true parent
          // flag with failing applies) must never happen.
          if (Object.values(out.result?.perControl ?? {})
            .some((p) => p?.errorCode === 'waiver-not-set')) {
            await backend.restoreWaiverState(deviceId, false);
          }
          return { result: out.result, state: out.state };
        }
        const out = await executeApply({ backend, oldIgcl, deviceId, settings: clamped });
        return { result: out.result, state: out.state };
      },

      'reset-to-defaults': async (deviceId) => {
        assertValidDeviceId(deviceId);
        // M2C-C: the reset write needs elevation like any other OC write
        // (0-value writes are refused even elevated — reset runs
        // ctlOverclockResetToDefault, which works elevated only). The
        // non-elevated app delegates to the elevated self-worker.
        let state;
        if (applyRunner?.needsWorker?.()) {
          const out = await applyRunner.reset(deviceId);
          state = out.state;
        } else {
          await backend.resetToDefaults(deviceId);
          state = await backend.getCurrentSettings(deviceId);
        }
        // No success claims without verification (plan §5): confirm the
        // supported OC controls moved to their capability defaults
        // (tolerance-aware). ctlOverclockResetToDefault does NOT touch fan
        // config, so only OC controls are checked. gpuLock is expected
        // unlocked (0,0) after a reset.
        const caps = await backend.getCapabilities(deviceId);
        const mismatched = [];
        for (const [key, range] of Object.entries(caps.ranges)) {
          const value = state?.[key];
          if (value !== null && value !== undefined && range && !nearlyEqual(value, range.default, RESET_VERIFY_EPS)) {
            mismatched.push(`${key}: read-back ${value} != default ${range.default}`);
          }
        }
        if (caps.controls.gpuLock && state?.gpuLock
          && (!nearlyEqual(state.gpuLock.voltageV, 0, RESET_VERIFY_EPS) || !nearlyEqual(state.gpuLock.freqMhz, 0, RESET_VERIFY_EPS))) {
          mismatched.push(`gpuLock: read-back ${state.gpuLock.voltageV}V/${state.gpuLock.freqMhz}MHz != unlocked (0,0)`);
        }
        if (mismatched.length > 0) {
          throw new Error(`reset-to-defaults verification failed: ${mismatched.join('; ')}`);
        }
        return { state };
      },

      'waiver-get': async (deviceId) => {
        assertValidDeviceId(deviceId);
        const caps = await backend.getCapabilities(deviceId);
        return { accepted: caps.waiverAccepted === true };
      },

      'waiver-accept': async (deviceId) => {
        assertValidDeviceId(deviceId);
        // Product path: explicit user acceptance ONLY. Never auto-accept.
        // M2C-C: the driver-side waiver write needs elevation like any other
        // OC write — the non-elevated app delegates to the elevated worker.
        if (applyRunner?.needsWorker?.()) {
          await applyRunner.waiverAccept(deviceId);
          // S2: the worker accepted on the driver — mirror the acceptance
          // into the parent's in-memory flag so getCapabilities/waiver-get
          // reflect it for the whole session (the worker's state is not
          // visible across the boundary).
          await backend.restoreWaiverState(deviceId, true);
        } else {
          await backend.setWaiverAccepted(deviceId);
        }
        const settings = await store.loadSettings();
        await store.saveSettings({ ...settings, waiverAccepted: true });
        return { accepted: true };
      },

      'telemetry-start': async (deviceId) => {
        assertValidDeviceId(deviceId);
        await startTelemetry(deviceId);
      },

      'telemetry-stop': async (deviceId) => {
        assertValidDeviceId(deviceId);
        const svc = telemetry.get(deviceId);
        if (svc) {
          await svc.stop();
          telemetry.delete(deviceId);
        }
      },

      // M3-A: the registry-hacks catalog (Tweaks page) — read-side only.
      // Real reg.exe queries in the product path (no elevation); the default
      // adapter is the MOCK so tests and --ui-verify never touch the real
      // registry. The M3-B apply channel is 'registry-apply'.
      'registry-catalog': async (...args) => {
        assertNoPayload(args, 'registry-catalog');
        return catalogAdapter.get();
      },

      // M3-B: apply one catalog action ELEVATED (Enable/Disable/Revert per
      // the entry's apply descriptor). The default adapter is the MOCK
      // (never spawns PowerShell, never elevates); ipc.js injects the real
      // adapter in the product path — every write then runs in an elevated
      // PowerShell (one UAC per action) and the result reports per-step
      // truth (including the UAC-cancel and partial-failure paths — no
      // silent partial state, no auto-revert). The entry's apply descriptor
      // is resolved HERE from the catalog: the renderer supplies only
      // entryId + action, never raw commands.
      'registry-apply': async (entryId, action) => {
        if (typeof entryId !== 'string' || entryId.length === 0) {
          throw new Error('registry-apply: entryId must be a non-empty string');
        }
        if (typeof action !== 'string' || !['enable', 'disable', 'revert'].includes(action)) {
          throw new Error('registry-apply: action must be one of enable, disable, revert');
        }
        return registryApplyAdapter.apply(entryId, action);
      },

      // Run-key (apply-on-startup) state (M2b). startup-set writes the HKCU
      // Run key ONLY on an explicit user click (the future Profiles UI
      // toggle); the default adapter is the MOCK so tests/ui-verify never
      // touch the real registry.
      'startup-get': async (...args) => {
        assertNoPayload(args, 'startup-get');
        return startup.get();
      },

      'startup-set': async (enabled, profileId) => {
        if (typeof enabled !== 'boolean') throw new Error('startup-set: enabled must be a boolean');
        if (enabled) {
          if (typeof profileId !== 'string' || profileId.length === 0) {
            throw new Error('startup-set: profileId is required when enabling');
          }
          // M2b review F6: the Run-key value is space-delimited
          // (buildRunValue/parseRunValue require \S+) — a whitespace id
          // would silently break the startup-get round trip.
          if (!/^\S+$/.test(profileId)) {
            throw new Error('startup-set: profileId must not contain whitespace');
          }
        } else if (profileId !== null && profileId !== undefined) {
          throw new Error('startup-set: profileId must be null when disabling');
        }
        await startup.set(enabled, enabled ? profileId : null);
        return startup.get();
      },

      // Display-driver registry date (M2b-B, read-only): never touches the
      // registry in mock mode — the default adapter returns the fixture.
      'driver-info': async (...args) => {
        assertNoPayload(args, 'driver-info');
        return driverInfo.get();
      },

      // App version for the header line (M2C-B B3, read-only): the product
      // path injects electron's app.getVersion(); the default reads
      // package.json so tests and --ui-verify never need electron.
      'app-version': async (...args) => {
        assertNoPayload(args, 'app-version');
        return { version: appVersion };
      },

      // M2C-C elevation state (read-only, cached koffi probe — no spawn):
      // `elevated` = this process runs as administrator; `workerApply` =
      // applies go through the elevated self-worker (product path, not
      // elevated). The renderer uses `workerApply` to show the
      // "Administrator approval is needed" toast before the UAC prompt.
      'app-elevated': async (...args) => {
        assertNoPayload(args, 'app-elevated');
        const elevated = isElevated();
        return { elevated, workerApply: applyRunner?.needsWorker?.() === true };
      },

      // FPS via PresentMon (M2b-B). The default adapter is the mock (always
      // null); the product path injects the real client, which itself
      // degrades to null when the DLL/service is unavailable. Never throws.
      'fps-poll': async (deviceId) => {
        assertValidDeviceId(deviceId);
        return presentmon.poll(deviceId);
      },

      // Profiles (M2b-B). Every channel returns the full envelope
      // { profiles, settings } so the renderer can re-render from one
      // response. `settings` mirrors ProfileStore.loadSettings() (the
      // persisted ocOnBoot / activeProfileId — the Run-key truth lives in
      // startup-get). Payloads are validated before touching the store.
      'profiles-list': async (...args) => {
        assertNoPayload(args, 'profiles-list');
        return { profiles: await store.loadProfiles(), settings: await store.loadSettings() };
      },

      'profiles-save': async (profile) => {
        if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
          throw new Error('profiles-save: profile must be an object');
        }
        if (typeof profile.id !== 'string' || profile.id.length === 0) {
          throw new Error('profiles-save: id must be a non-empty string');
        }
        // M2b review F6: profile ids become Run-key values (startup-set) —
        // whitespace would silently break the startup-get round trip.
        if (!/^\S+$/.test(profile.id)) {
          throw new Error('profiles-save: id must not contain whitespace');
        }
        if (typeof profile.name !== 'string' || profile.name.trim().length === 0) {
          throw new Error('profiles-save: name must be a non-empty string');
        }
        if (typeof profile.ocOnBoot !== 'boolean') {
          throw new Error('profiles-save: ocOnBoot must be a boolean');
        }
        const settings = sanitizeSettings(profile.settings ?? {});
        const existing = (await store.loadProfiles()).find((p) => p.id === profile.id);
        await store.saveProfile({
          id: profile.id,
          name: profile.name.trim(),
          createdAt: existing?.createdAt ?? (typeof profile.createdAt === 'string' ? profile.createdAt : new Date().toISOString()),
          settings,
          ocOnBoot: profile.ocOnBoot,
        });
        return { profiles: await store.loadProfiles(), settings: await store.loadSettings() };
      },

      'profiles-delete': async (id) => {
        if (typeof id !== 'string' || id.length === 0) {
          throw new Error('profiles-delete: id must be a non-empty string');
        }
        await store.deleteProfile(id);
        return { profiles: await store.loadProfiles(), settings: await store.loadSettings() };
      },

      'profiles-rename': async (id, name) => {
        if (typeof id !== 'string' || id.length === 0) {
          throw new Error('profiles-rename: id must be a non-empty string');
        }
        if (typeof name !== 'string' || name.trim().length === 0) {
          throw new Error('profiles-rename: name must be a non-empty string');
        }
        const profiles = await store.loadProfiles();
        const profile = profiles.find((p) => p.id === id);
        if (!profile) throw new Error(`profiles-rename: profile '${id}' not found`);
        await store.saveProfile({ ...profile, name: name.trim() });
        return { profiles: await store.loadProfiles(), settings: await store.loadSettings() };
      },

      // Persisted-settings patch (activeProfileId / ocOnBoot). Read-modify-
      // write in main so the renderer can never clobber waiverAccepted.
      'profiles-settings-save': async (patch) => {
        if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
          throw new Error('profiles-settings-save: patch must be an object');
        }
        const cur = await store.loadSettings();
        const next = {
          waiverAccepted: cur.waiverAccepted,
          ocOnBoot: patch.ocOnBoot === undefined ? cur.ocOnBoot : patch.ocOnBoot === true,
          activeProfileId: patch.activeProfileId === undefined
            ? cur.activeProfileId
            : (typeof patch.activeProfileId === 'string' && patch.activeProfileId.length > 0 ? patch.activeProfileId : null),
          // M3-C-E: the OC mode is never touched by the profiles patch.
          ocMode: cur.ocMode,
          // M4-B: the once-only Advanced-mode warning acceptance is never
          // touched by the profiles patch either.
          advancedModeAccepted: cur.advancedModeAccepted,
        };
        await store.saveSettings(next);
        return next;
      },

      // M3-C-E: the OC mode (stock | advanced), persisted in settings.json.
      // The mode drives which limits getCapabilities exposes (extended
      // ranges only in advanced) and the shared pre-clamp refusal gate in
      // every apply path.
      'oc-mode-get': async (...args) => {
        assertNoPayload(args, 'oc-mode-get');
        const s = await store.loadSettings();
        return { ocMode: s.ocMode };
      },

      'oc-mode-set': async (ocMode) => {
        if (!OC_MODES.includes(ocMode)) {
          throw new Error(`oc-mode-set: ocMode must be one of ${OC_MODES.join(', ')}`);
        }
        const cur = await store.loadSettings();
        await store.saveSettings({ ...cur, ocMode });
        // Invalidate the backend's per-device caps cache: getCapabilities
        // re-derives the extended ranges from the new mode on the next call.
        if (typeof backend.setOcMode === 'function') {
          await backend.setOcMode(ocMode);
        }
        return { ocMode };
      },

      // M4-B (user): the Advanced OC Mode warning is accepted ONCE and
      // persisted — the renderer shows the disclaimer only on the FIRST
      // Stock->Advanced toggle and skips it on every later boot. There is
      // no revoke path (nothing resets the acceptance), mirroring the
      // waiver's persisted-acceptance pattern.
      'advanced-mode-accepted-get': async (...args) => {
        assertNoPayload(args, 'advanced-mode-accepted-get');
        const s = await store.loadSettings();
        return { accepted: s.advancedModeAccepted === true };
      },

      'advanced-mode-accepted-set': async (...args) => {
        assertNoPayload(args, 'advanced-mode-accepted-set');
        const cur = await store.loadSettings();
        await store.saveSettings({ ...cur, advancedModeAccepted: true });
        return { accepted: true };
      },

      // Rebuild the tray menu after any profile change (M2b-B). The product
      // path injects the tray ref; the default is a no-op so tests and
      // --ui-verify never depend on a tray existing.
      'tray-rebuild': async (...args) => {
        assertNoPayload(args, 'tray-rebuild');
        await rebuildTray();
        return { ok: true };
      },
    };

    // M2D: the mock-featureset channels exist ONLY in mock mode (mock ctx
    // injected by ipc.js/main.js). Real mode has no such channel — invoking
    // it rejects with the honest "No handler registered" 404.
    if (mock) {
      handlers['mock:list-featuresets'] = async (...args) => {
        assertNoPayload(args, 'mock:list-featuresets');
        return mock.listFeaturesets();
      };
      handlers['mock:set-featureset'] = async (id) => {
        if (typeof id !== 'string' || id.length === 0) {
          throw new Error('mock:set-featureset: id must be a non-empty string');
        }
        return mock.setFeatureset(id);
      };
    }

    return { handlers, stopAllTelemetry };
}
