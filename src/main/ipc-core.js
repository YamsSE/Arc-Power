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

import { TelemetryService } from './telemetry/telemetry-service.js';
import { collectHealth } from './health.js';
import { CONTROLS } from './backend/backend.interface.js';
import { clampAndSnap, clampGpuLock, nearlyEqual } from './backend/units.js';
import { createMockIgs } from './igs-service.js';
import { createMockStartup } from './startup.js';
import { createMockDriverInfo } from './driver-info.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
// io-failed apply retry policy (M2b): the A770 driver's OC-write acceptance
// flaps on a minutes scale (docs/igcl-integration.md §8a) — a transient
// io-failed apply is retried with backoff. User-fixable errors (waiver,
// out-of-range, locked-mode) are NEVER retried.
const APPLY_RETRY_BACKOFF_MS = 800;
const APPLY_MAX_RETRIES = 2;

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
  if (out.gpuLock) out.gpuLock = clampGpuLock(out.gpuLock, ranges);
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
 * Channels that take no payload must never receive one (the preload only
 * calls them bare, but the whitelist is the enforcement point).
 */
export function assertNoPayload(args, channel) {
  if (args.length > 0) {
    throw new Error(`${channel} takes no payload`);
  }
}

/**
 * True when an ApplyResult has at least one io-failed control (the only
 * transient failure class worth retrying — the driver flaps on a minutes
 * scale; waiver/out-of-range/locked-mode are user-fixable and NOT retried).
 * @param {{ ok: boolean, perControl: Record<string, { errorCode?: string }> }} result
 */
export function hasIoFailed(result) {
  return result.ok === false
    && Object.values(result.perControl ?? {}).some((p) => p.errorCode === 'io-failed');
}

/**
 * Build the handler map for every whitelisted channel.
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   store: import('./store/profile-store.js').ProfileStore,
 *   emit: (channel: string, payload: unknown) => void,
 *   igs?: { getState: () => Promise<unknown>, disable: () => Promise<unknown>, enable: () => Promise<unknown> },
 *   startup?: { get: () => Promise<unknown>, set: (enabled: boolean, profileId: string | null) => Promise<unknown> },
 *   driverInfo?: { get: () => Promise<{ driverDate: string | null }> },
 *   presentmon?: { poll: (deviceId: number) => Promise<{ fps: number | null, frameTimeMs: number | null, gpuBusy: number | null } | null> },
 *   rebuildTray?: () => Promise<unknown>,
 *   applyRetryBackoffMs?: number,
 *   applyMaxRetries?: number,
 * }} ctx
 */
export function createIpcHandlers({
  backend,
  store,
  emit,
  igs = createMockIgs(),
  startup = createMockStartup(),
  driverInfo = createMockDriverInfo(),
  // M2b-B: the FPS adapter. The DEFAULT is the mock (always unavailable —
  // never loads koffi/PresentMonAPI2); ipc.js injects the real client in the
  // product path. On this machine the real client degrades to null anyway
  // (no PresentMon service), so mock and product agree on 'unavailable'.
  presentmon = { poll: async () => null },
  rebuildTray = async () => {},
  applyRetryBackoffMs = APPLY_RETRY_BACKOFF_MS,
  applyMaxRetries = APPLY_MAX_RETRIES,
}) {
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

  return {
    handlers: {
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
        const caps = await backend.getCapabilities(deviceId);
        const clamped = clampSettings(settings, caps.ranges);
        let result = await backend.applySettings(deviceId, clamped);
        let retried = false;
        // io-failed retry policy: transient driver flakiness gets up to
        // `applyMaxRetries` re-attempts with backoff; user-fixable errors are
        // returned as-is (never retried).
        for (let attempt = 0; hasIoFailed(result) && attempt < applyMaxRetries; attempt++) {
          await sleep(applyRetryBackoffMs);
          result = await backend.applySettings(deviceId, clamped);
          retried = true;
        }
        if (retried) result = { ...result, retried: true };
        // IGS may change OC state between runs — always re-read after apply.
        const state = await backend.getCurrentSettings(deviceId);
        return { result, state };
      },

      'reset-to-defaults': async (deviceId) => {
        assertValidDeviceId(deviceId);
        await backend.resetToDefaults(deviceId);
        // No success claims without verification (plan §5): re-read after
        // the reset and confirm the supported OC controls moved to their
        // capability defaults (tolerance-aware). ctlOverclockResetToDefault
        // does NOT touch fan config, so only OC controls are checked.
        // gpuLock is expected unlocked (0,0) after a reset.
        const caps = await backend.getCapabilities(deviceId);
        const state = await backend.getCurrentSettings(deviceId);
        const mismatched = [];
        for (const [key, range] of Object.entries(caps.ranges)) {
          const value = state[key];
          if (value !== null && value !== undefined && range && !nearlyEqual(value, range.default, RESET_VERIFY_EPS)) {
            mismatched.push(`${key}: read-back ${value} != default ${range.default}`);
          }
        }
        if (caps.controls.gpuLock && state.gpuLock
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
        await backend.setWaiverAccepted(deviceId);
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

      // IGS service (M2a extension): state probe is read-only; disable/enable
      // spawn an ELEVATED helper — they run ONLY on an explicit user click.
      // The adapter defaults to the MOCK (never the real service): real
      // elevation is unreachable unless ipc.js explicitly injects it.
      'igs-service-state': async (...args) => {
        assertNoPayload(args, 'igs-service-state');
        return igs.getState();
      },

      'igs-service-disable': async (...args) => {
        assertNoPayload(args, 'igs-service-disable');
        return igs.disable();
      },

      'igs-service-enable': async (...args) => {
        assertNoPayload(args, 'igs-service-enable');
        return igs.enable();
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
        };
        await store.saveSettings(next);
        return next;
      },

      // Rebuild the tray menu after any profile change (M2b-B). The product
      // path injects the tray ref; the default is a no-op so tests and
      // --ui-verify never depend on a tray existing.
      'tray-rebuild': async (...args) => {
        assertNoPayload(args, 'tray-rebuild');
        await rebuildTray();
        return { ok: true };
      },
    },
    stopAllTelemetry,
  };
}
