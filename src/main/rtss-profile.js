// Optional RTSS profile bridge used by the native Arc Power HUD.
//
// RTSS's shared-memory writer supplies the content, but RTSS's profile still
// controls whether the hooked application is detected and which text
// renderer paints the OSD. Keep this bridge best-effort: a missing or older
// RTSS installation must never prevent Arc Power from starting.

import koffi from 'koffi';
import path from 'node:path';
import { existsSync } from 'node:fs';

export const RTSS_VECTOR_2D = 1;
export const RTSS_MIN_APP_DETECTION_LEVEL = 1;
export const RTSS_GLOBAL_PROFILE = '';

const UINT32_SIZE = 4;
const PROFILE_DLL_NAMES = Object.freeze(['RTSSHooks64.dll', 'RTSSHooks.dll']);

function profileDllPaths(executablePath) {
  if (typeof executablePath !== 'string' || executablePath.trim().length === 0) return [];
  const root = path.dirname(executablePath.trim());
  return PROFILE_DLL_NAMES.map((name) => path.join(root, name));
}

function bindProfileApi(library) {
  if (!library || typeof library.func !== 'function') return null;
  const bind = (name, result, parameters) => {
    try { return library.func(name, result, parameters); } catch { return null; }
  };
  const api = {
    loadProfile: bind('LoadProfile', 'void', ['str']),
    saveProfile: bind('SaveProfile', 'void', ['str']),
    getProfileProperty: bind('GetProfileProperty', 'bool', ['str', 'void*', 'uint32']),
    setProfileProperty: bind('SetProfileProperty', 'bool', ['str', 'void*', 'uint32']),
    updateProfiles: bind('UpdateProfiles', 'void', []),
  };
  return Object.values(api).every((fn) => typeof fn === 'function') ? api : null;
}

function readProfileProperty(api, name) {
  const buffer = Buffer.alloc(UINT32_SIZE);
  try {
    if (!api.getProfileProperty(name, buffer, UINT32_SIZE)) return null;
    return buffer.readUInt32LE(0);
  } catch {
    return null;
  }
}

function writeProfileProperty(api, name, value) {
  const buffer = Buffer.alloc(UINT32_SIZE);
  buffer.writeUInt32LE(value >>> 0, 0);
  return api.setProfileProperty(name, buffer, UINT32_SIZE) === true;
}

function cloneState(state) {
  return { ...state };
}

/**
 * Create the optional RTSS profile synchronizer.
 *
 * `getExecutablePath`, `exists`, and `load` are injectable so the profile
 * policy can be verified without touching a user's RTSS installation.
 */
export function createRtssProfileController({
  platform = process.platform,
  executablePath = null,
  getExecutablePath = null,
  exists = existsSync,
  load = (filePath) => koffi.load(filePath),
} = {}) {
  let bindings = null;
  let loadedPath = null;
  let terminalLoadFailure = false;
  // Keep only the global-profile values Arc Power changed.  RTSS is shared by
  // other applications, so disabling our HUD must not blindly reset values a
  // user changed while the HUD was active.
  let appliedProfileSnapshot = null;
  let state = {
    available: false,
    configured: false,
    renderingMode: 'unknown',
    executablePath: null,
    error: null,
  };
  let queue = Promise.resolve();

  const resolveExecutablePath = async () => {
    if (typeof executablePath === 'string' && executablePath.trim().length > 0) return executablePath.trim();
    if (typeof getExecutablePath !== 'function') return null;
    try {
      const resolved = await getExecutablePath();
      return typeof resolved === 'string' && resolved.trim().length > 0 ? resolved.trim() : null;
    } catch {
      return null;
    }
  };

  const resolveBindings = async () => {
    if (bindings) return bindings;
    if (terminalLoadFailure) return null;
    const executable = await resolveExecutablePath();
    if (!executable) return null;
    const candidates = profileDllPaths(executable);
    const dllPath = candidates.find((candidate) => {
      try { return exists(candidate); } catch { return false; }
    });
    if (!dllPath) return null;
    try {
      bindings = bindProfileApi(load(dllPath));
    } catch {
      bindings = null;
    }
    if (!bindings) {
      terminalLoadFailure = true;
      return null;
    }
    loadedPath = dllPath;
    state = { ...state, available: true, executablePath: executable, error: null };
    return bindings;
  };

  const applyNow = async ({ enabled = false } = {}) => {
    if (enabled !== true) {
      if (platform !== 'win32' || !appliedProfileSnapshot) {
        state = { ...state, configured: false, renderingMode: platform === 'win32' ? 'unknown' : 'unsupported', error: null };
        return cloneState(state);
      }

      const api = bindings ?? await resolveBindings();
      if (!api) {
        state = {
          ...state,
          configured: false,
          renderingMode: 'unknown',
          error: 'RTSS profile could not be restored',
        };
        return cloneState(state);
      }

      try {
        api.loadProfile(RTSS_GLOBAL_PROFILE);
        let changed = false;
        for (const entry of appliedProfileSnapshot) {
          const current = readProfileProperty(api, entry.property);
          // Restore only values that still equal Arc Power's target.  This
          // leaves an intentional change made externally while the HUD was on.
          if (current !== entry.desired || entry.previous === null || entry.previous === current) continue;
          if (!writeProfileProperty(api, entry.property, entry.previous)) {
            throw new Error(`RTSS ${entry.property} could not be restored`);
          }
          changed = true;
        }
        if (changed) {
          api.saveProfile(RTSS_GLOBAL_PROFILE);
          api.updateProfiles();
        }
        appliedProfileSnapshot = null;
        state = { ...state, configured: false, renderingMode: 'unknown', error: null };
      } catch (cause) {
        state = {
          ...state,
          configured: false,
          renderingMode: 'unknown',
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
      return cloneState(state);
    }
    if (platform !== 'win32') {
      state = { ...state, available: false, configured: false, renderingMode: 'unsupported', error: null };
      return cloneState(state);
    }
    const api = await resolveBindings();
    if (!api) return cloneState(state);

    try {
      api.loadProfile(RTSS_GLOBAL_PROFILE);
      const before = {
        implementation: readProfileProperty(api, 'Implementation'),
        detection: readProfileProperty(api, 'AppDetectionLevel'),
        enabled: readProfileProperty(api, 'EnableOSD'),
      };
      const changes = [
        ...(before.implementation !== RTSS_VECTOR_2D
          ? [{ property: 'Implementation', previous: before.implementation, desired: RTSS_VECTOR_2D }]
          : []),
        ...(before.detection === null || before.detection < RTSS_MIN_APP_DETECTION_LEVEL
          ? [{ property: 'AppDetectionLevel', previous: before.detection, desired: RTSS_MIN_APP_DETECTION_LEVEL }]
          : []),
        ...(before.enabled !== 1
          ? [{ property: 'EnableOSD', previous: before.enabled, desired: 1 }]
          : []),
      ];
      if (changes.length > 0 && appliedProfileSnapshot === null) appliedProfileSnapshot = changes;
      let changed = false;
      if (before.implementation !== RTSS_VECTOR_2D) {
        if (!writeProfileProperty(api, 'Implementation', RTSS_VECTOR_2D)) throw new Error('RTSS Implementation could not be updated');
        changed = true;
      }
      if (before.detection === null || before.detection < RTSS_MIN_APP_DETECTION_LEVEL) {
        if (!writeProfileProperty(api, 'AppDetectionLevel', RTSS_MIN_APP_DETECTION_LEVEL)) throw new Error('RTSS application detection could not be updated');
        changed = true;
      }
      if (before.enabled !== 1) {
        if (!writeProfileProperty(api, 'EnableOSD', 1)) throw new Error('RTSS OSD could not be enabled');
        changed = true;
      }
      if (changed) {
        api.saveProfile(RTSS_GLOBAL_PROFILE);
        api.updateProfiles();
      }
      state = {
        ...state,
        available: true,
        configured: true,
        renderingMode: 'vector2d',
        executablePath: state.executablePath ?? await resolveExecutablePath(),
        error: null,
      };
    } catch (cause) {
      state = {
        ...state,
        available: true,
        configured: false,
        renderingMode: 'unknown',
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
    return cloneState(state);
  };

  const apply = (options = {}) => {
    const next = queue.catch(() => {}).then(() => applyNow(options));
    queue = next.catch(() => {});
    return next;
  };

  return {
    apply,
    getState: () => cloneState({ ...state, dllPath: loadedPath }),
  };
}
