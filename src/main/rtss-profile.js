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
export const RTSS_LIMITER_DISABLED_FLAG = 4;
export const RTSS_FRAME_LIMIT_RANGE = Object.freeze({ min: 1, max: 1000, step: 1, default: 60 });

const UINT32_SIZE = 4;
const PROFILE_DLL_NAMES = Object.freeze(['RTSSHooks64.dll', 'RTSSHooks.dll']);
const RTSS_FRAME_LIMIT_PROPERTY = 'FramerateLimit';
const RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY = 'FramerateLimitDenominator';

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
    setFlags: bind('SetFlags', 'uint32', ['uint32', 'uint32']),
    enumProfiles: bind('EnumProfiles', 'uint32', ['void*', 'uint32']),
    deleteProfile: bind('DeleteProfile', 'void', ['str']),
  };
  const required = ['loadProfile', 'saveProfile', 'getProfileProperty', 'setProfileProperty', 'updateProfiles'];
  return required.every((key) => typeof api[key] === 'function') ? api : null;
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

function profileNameOf(executablePath) {
  if (typeof executablePath !== 'string' || executablePath.trim().length === 0) return RTSS_GLOBAL_PROFILE;
  const name = path.win32.basename(executablePath.trim());
  return name && name !== '.' && name !== '\\' ? name : RTSS_GLOBAL_PROFILE;
}

function enumerateProfiles(api) {
  if (typeof api?.enumProfiles !== 'function') return null;
  try {
    const required = Number(api.enumProfiles(null, 0));
    if (!Number.isInteger(required) || required <= 0 || required > 1024 * 1024) return null;
    const buffer = Buffer.alloc(required);
    api.enumProfiles(buffer, required);
    const text = buffer.toString('utf8').replaceAll('\0', '');
    return new Set(text.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean));
  } catch {
    return null;
  }
}

function readLimiterFlags(api) {
  if (typeof api?.setFlags !== 'function') return null;
  try {
    const flags = Number(api.setFlags(0xFFFFFFFF, 0));
    return Number.isFinite(flags) ? (flags >>> 0) : null;
  } catch {
    return null;
  }
}

function setLimiterEnabled(api, enabled) {
  const current = readLimiterFlags(api);
  if (current === null) return false;
  const disabled = (current & RTSS_LIMITER_DISABLED_FLAG) !== 0;
  const shouldDisable = enabled !== true;
  if (disabled === shouldDisable) return true;
  try {
    const next = Number(api.setFlags(0xFFFFFFFF, RTSS_LIMITER_DISABLED_FLAG)) >>> 0;
    return ((next & RTSS_LIMITER_DISABLED_FLAG) !== 0) === shouldDisable;
  } catch {
    return false;
  }
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
  // FPS-limit ownership is tracked separately from the OSD profile changes.
  // A user may already have RTSS limits configured, so Arc Power restores
  // only values it changed and only while they still equal Arc Power's last
  // target.
  const frameLimitSnapshots = new Map();
  const activeFrameLimitProfiles = new Set();
  let limiterFlagSnapshot = null;

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

  const readFrameLimitNow = async ({ executablePath: targetExecutablePath = null } = {}) => {
    if (platform !== 'win32') {
      return { ok: false, available: false, source: 'igcl', error: 'RTSS requires Windows' };
    }
    const api = bindings ?? await resolveBindings();
    if (!api || typeof api.setFlags !== 'function') {
      return { ok: false, available: false, source: 'igcl', error: 'RTSS frame limiter is unavailable' };
    }
    const profile = profileNameOf(targetExecutablePath);
    try {
      api.loadProfile(profile);
      const limit = readProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY);
      const denominator = readProfileProperty(api, RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY);
      const flags = readLimiterFlags(api);
      if (limit === null || flags === null) throw new Error('RTSS frame limiter read-back failed');
      return {
        ok: true,
        available: true,
        source: 'rtss',
        profile,
        limit,
        denominator: denominator ?? 1,
        limiterEnabled: (flags & RTSS_LIMITER_DISABLED_FLAG) === 0,
      };
    } catch (cause) {
      return {
        ok: false,
        available: true,
        source: 'igcl',
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  };

  const restoreLimiterFlagIfIdle = (api) => {
    if (activeFrameLimitProfiles.size > 0 || !limiterFlagSnapshot) return false;
    const current = readLimiterFlags(api);
    if (current === null) return false;
    const currentDisabled = (current & RTSS_LIMITER_DISABLED_FLAG) !== 0;
    // Do not overwrite a change made outside Arc Power while our limiter was
    // active. Only restore when the shared flag is still at our last target.
    if (currentDisabled === limiterFlagSnapshot.desiredDisabled) {
      if (!setLimiterEnabled(api, limiterFlagSnapshot.previousEnabled)) return false;
    }
    limiterFlagSnapshot = null;
    return true;
  };

  const rollbackFrameLimitChange = (api, profile) => {
    const snapshot = frameLimitSnapshots.get(profile);
    if (!snapshot) return;
    try {
      api.loadProfile(profile);
      const current = readProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY);
      const denominator = readProfileProperty(api, RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY);
      const matches = current === snapshot.desiredLimit
        && (snapshot.desiredDenominator === null || denominator === snapshot.desiredDenominator);
      if (matches) {
        if (snapshot.existed) {
          if (snapshot.previousLimit !== null && current !== snapshot.previousLimit) writeProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY, snapshot.previousLimit);
          if (snapshot.previousDenominator !== null && denominator !== snapshot.previousDenominator) writeProfileProperty(api, RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY, snapshot.previousDenominator);
          api.saveProfile(profile);
        } else if (profile !== RTSS_GLOBAL_PROFILE && snapshot.created === true && typeof api.deleteProfile === 'function') {
          api.deleteProfile(profile);
        }
      }
      frameLimitSnapshots.delete(profile);
      activeFrameLimitProfiles.delete(profile);
      restoreLimiterFlagIfIdle(api);
    } catch {
      // A failed rollback must not turn an optional RTSS integration into a
      // startup/apply failure. The original failure still selects IGCL.
    }
  };

  const applyFrameLimitNow = async ({ enabled = false, value = RTSS_FRAME_LIMIT_RANGE.default, executablePath: targetExecutablePath = null, removeProfile = false } = {}) => {
    if (platform !== 'win32') {
      return { ok: false, used: false, fallback: true, source: 'igcl', error: 'RTSS requires Windows' };
    }
    const api = bindings ?? await resolveBindings();
    if (!api || typeof api.setFlags !== 'function') {
      return { ok: false, used: false, fallback: true, source: 'igcl', error: 'RTSS frame limiter is unavailable' };
    }
    const profile = profileNameOf(targetExecutablePath);
    const requestedLimit = enabled === true
      ? Math.min(RTSS_FRAME_LIMIT_RANGE.max, Math.max(RTSS_FRAME_LIMIT_RANGE.min, Math.round(Number(value) || RTSS_FRAME_LIMIT_RANGE.default)))
      : 0;
    try {
      api.loadProfile(profile);
      const beforeLimit = readProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY);
      const beforeDenominator = readProfileProperty(api, RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY);
      if (beforeLimit === null) throw new Error('RTSS FramerateLimit property is unavailable');

      if (enabled !== true) {
        const snapshot = frameLimitSnapshots.get(profile);
        let changed = false;
        if (profile !== RTSS_GLOBAL_PROFILE && removeProfile === true && typeof api.deleteProfile === 'function') {
          // The caller only requests this after removing an Arc Power-owned
          // sidecar assignment. It is needed across restarts, where the
          // in-memory snapshot cannot prove that Arc Power created the RTSS
          // profile. A normal Off apply keeps the conservative snapshot-only
          // restoration policy below.
          api.deleteProfile(profile);
          frameLimitSnapshots.delete(profile);
          activeFrameLimitProfiles.delete(profile);
          const flagRestored = restoreLimiterFlagIfIdle(api);
          api.updateProfiles();
          return { ok: true, used: true, source: 'rtss', profile, enabled: false, value: 0, changed: true, removed: true, flagRestored };
        }
        if (profile === RTSS_GLOBAL_PROFILE) {
          // Restore a value Arc Power changed in this process while it still
          // matches our last target. If there is no snapshot (for example a
          // restart after an older Arc Power session), explicitly turning the
          // General control Off clears the persisted global cap.
          const owned = snapshot
            && beforeLimit === snapshot.desiredLimit
            && (snapshot.desiredDenominator === null || beforeDenominator === snapshot.desiredDenominator);
          if (owned && snapshot.previousLimit !== null && beforeLimit !== snapshot.previousLimit) {
            if (!writeProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY, snapshot.previousLimit)
              || readProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY) !== snapshot.previousLimit) {
              throw new Error('RTSS FramerateLimit could not be restored');
            }
            changed = true;
          }
          if (owned && snapshot.previousDenominator !== null && beforeDenominator !== snapshot.previousDenominator) {
            if (!writeProfileProperty(api, RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY, snapshot.previousDenominator)
              || readProfileProperty(api, RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY) !== snapshot.previousDenominator) {
              throw new Error('RTSS FramerateLimitDenominator could not be restored');
            }
            changed = true;
          }
          if (!owned && !snapshot) {
            if (beforeLimit !== 0) {
              if (!writeProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY, 0)
                || readProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY) !== 0) {
                throw new Error('RTSS FramerateLimit could not be disabled');
              }
              changed = true;
            }
            if (beforeDenominator !== null && beforeDenominator !== 1) {
              if (!writeProfileProperty(api, RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY, 1)
                || readProfileProperty(api, RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY) !== 1) {
                throw new Error('RTSS FramerateLimitDenominator could not be reset');
              }
              changed = true;
            }
          }
          if (changed) api.saveProfile(profile);
          frameLimitSnapshots.delete(profile);
        } else if (snapshot
          && beforeLimit === snapshot.desiredLimit
          && (snapshot.desiredDenominator === null || beforeDenominator === snapshot.desiredDenominator)) {
          if (snapshot.existed) {
            if (snapshot.previousLimit !== null && beforeLimit !== snapshot.previousLimit) {
              if (!writeProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY, snapshot.previousLimit)
                || readProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY) !== snapshot.previousLimit) {
                throw new Error('RTSS FramerateLimit could not be restored');
              }
              changed = true;
            }
            if (snapshot.previousDenominator !== null && beforeDenominator !== snapshot.previousDenominator) {
              if (!writeProfileProperty(api, RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY, snapshot.previousDenominator)
                || readProfileProperty(api, RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY) !== snapshot.previousDenominator) {
                throw new Error('RTSS FramerateLimitDenominator could not be restored');
              }
              changed = true;
            }
            if (changed) api.saveProfile(profile);
          } else if (profile !== RTSS_GLOBAL_PROFILE && snapshot.created === true && typeof api.deleteProfile === 'function') {
            api.deleteProfile(profile);
            changed = true;
          } else if (profile !== RTSS_GLOBAL_PROFILE && snapshot.previousLimit !== null
            && beforeLimit !== snapshot.previousLimit) {
            if (!writeProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY, snapshot.previousLimit)
              || readProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY) !== snapshot.previousLimit) {
              throw new Error('RTSS FramerateLimit could not be restored');
            }
            changed = true;
            api.saveProfile(profile);
          }
          frameLimitSnapshots.delete(profile);
        }
        if (snapshot && frameLimitSnapshots.has(profile)) frameLimitSnapshots.delete(profile);
        activeFrameLimitProfiles.delete(profile);
        const flagRestored = restoreLimiterFlagIfIdle(api);
        if (changed || flagRestored) api.updateProfiles();
        return { ok: true, used: true, source: 'rtss', profile, enabled: false, value: 0, changed };
      }

      if (!frameLimitSnapshots.has(profile)) {
        const profiles = enumerateProfiles(api);
        const existed = profile === RTSS_GLOBAL_PROFILE
          || profiles === null
          || profiles.has(profile.toLowerCase());
        frameLimitSnapshots.set(profile, {
          existed,
          previousLimit: beforeLimit,
          previousDenominator: beforeDenominator,
          desiredLimit: requestedLimit,
          desiredDenominator: beforeDenominator === null ? null : 1,
          created: false,
        });
      }
      const snapshot = frameLimitSnapshots.get(profile);
      snapshot.desiredLimit = requestedLimit;
      snapshot.desiredDenominator = beforeDenominator === null ? null : 1;

      let changed = false;
      if (beforeLimit !== requestedLimit) {
        if (!writeProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY, requestedLimit)
          || readProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY) !== requestedLimit) {
          throw new Error('RTSS FramerateLimit could not be updated');
        }
        changed = true;
      }
      if (beforeDenominator !== null && beforeDenominator !== 1) {
        if (!writeProfileProperty(api, RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY, 1)
          || readProfileProperty(api, RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY) !== 1) {
          throw new Error('RTSS FramerateLimitDenominator could not be updated');
        }
        changed = true;
      }
      if (changed) {
        api.saveProfile(profile);
        if (profile !== RTSS_GLOBAL_PROFILE && snapshot.existed === false) snapshot.created = true;
      }

      if (!limiterFlagSnapshot) {
        const flags = readLimiterFlags(api);
        if (flags === null) throw new Error('RTSS limiter state could not be read');
        limiterFlagSnapshot = {
          previousEnabled: (flags & RTSS_LIMITER_DISABLED_FLAG) === 0,
          desiredDisabled: false,
        };
      }
      const flagsBeforeEnable = readLimiterFlags(api);
      if (flagsBeforeEnable === null || !setLimiterEnabled(api, true)) {
        throw new Error('RTSS frame limiter could not be enabled');
      }
      activeFrameLimitProfiles.add(profile);
      if (changed || flagsBeforeEnable !== readLimiterFlags(api)) api.updateProfiles();
      return { ok: true, used: true, source: 'rtss', profile, enabled: true, value: requestedLimit, changed };
    } catch (cause) {
      rollbackFrameLimitChange(api, profile);
      return {
        ok: false,
        used: false,
        fallback: true,
        source: 'igcl',
        profile,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
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

  const getFrameLimit = (options = {}) => {
    const next = queue.catch(() => {}).then(() => readFrameLimitNow(options));
    queue = next.catch(() => {});
    return next;
  };

  const applyFrameLimit = (options = {}) => {
    const next = queue.catch(() => {}).then(() => applyFrameLimitNow(options));
    queue = next.catch(() => {});
    return next;
  };

  return {
    apply,
    getFrameLimit,
    applyFrameLimit,
    getState: () => cloneState({ ...state, dllPath: loadedPath }),
  };
}
