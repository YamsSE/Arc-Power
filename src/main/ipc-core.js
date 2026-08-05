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
 * Build the handler map for every whitelisted channel.
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   store: import('./store/profile-store.js').ProfileStore,
 *   emit: (channel: string, payload: unknown) => void,
 * }} ctx
 */
export function createIpcHandlers({ backend, store, emit }) {
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
        const result = await backend.applySettings(deviceId, clamped);
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
    },
    stopAllTelemetry,
  };
}
