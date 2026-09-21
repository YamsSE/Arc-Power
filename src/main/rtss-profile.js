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
    if (!Number.isInteger(required) || required < 0 || required > 1024 * 1024) return null;
    if (required === 0) return new Set();
    const buffer = Buffer.alloc(required);
    api.enumProfiles(buffer, required);
    const text = buffer.toString('utf8').replaceAll('\0', '');
    return new Set(text.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean));
  } catch {
    return null;
  }
}

function deleteProfileVerified(api, profile) {
  if (typeof api?.deleteProfile !== 'function') return { ok: false, error: 'RTSS profile deletion is unavailable' };
  try {
    api.deleteProfile(profile);
    api.updateProfiles();
    const profiles = enumerateProfiles(api);
    if (!(profiles instanceof Set)) return { ok: false, error: 'RTSS profile deletion could not be verified' };
    return profiles.has(profile.toLowerCase())
      ? { ok: false, error: 'RTSS profile remained after deletion' }
      : { ok: true };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
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
  isRunning = async () => true,
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

  const frameLimiterAvailability = async () => {
    if (platform !== 'win32') {
      return { ok: false, available: false, source: 'igcl', error: 'RTSS requires Windows' };
    }
    try {
      if (typeof isRunning === 'function' && await isRunning() === true) return null;
    } catch {
      // A failed process probe is not proof that RTSS is available. Keep the
      // Intel driver limiter as the safe fallback instead of claiming RTSS
      // ownership from a DLL that may only be installed on disk.
    }
    return { ok: false, available: false, source: 'igcl', error: 'RTSS is not running' };
  };

  const readFrameLimitNow = async ({ executablePath: targetExecutablePath = null } = {}) => {
    const unavailable = await frameLimiterAvailability();
    if (unavailable) return unavailable;
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
    if (!limiterFlagSnapshot) return { ok: true, restored: true, deferred: false };
    // The shared RTSS limiter flag belongs to all Arc Power-owned profiles.
    // Releasing one profile while another is still active is successful
    // cleanup, but the shared flag must stay owned until the final profile is
    // released. Returning false here made the first profile look like a
    // failed delete and left the sidecar in a misleading cleanup-pending
    // state.
    if (activeFrameLimitProfiles.size > 0) return { ok: true, restored: false, deferred: true };
    const current = readLimiterFlags(api);
    if (current === null) return { ok: false, restored: false, deferred: false };
    const currentDisabled = (current & RTSS_LIMITER_DISABLED_FLAG) !== 0;
    // Do not overwrite a change made outside Arc Power while our limiter was
    // active. Only restore when the shared flag is still at our last target.
    if (currentDisabled !== limiterFlagSnapshot.desiredDisabled) return { ok: false, restored: false, deferred: false };
    if (!setLimiterEnabled(api, limiterFlagSnapshot.previousEnabled)) return { ok: false, restored: false, deferred: false };
    limiterFlagSnapshot = null;
    return { ok: true, restored: true, deferred: false };
  };

  const rollbackFrameLimitChange = (api, profile) => {
    const snapshot = frameLimitSnapshots.get(profile);
    if (!snapshot) return { ok: true };
    try {
      api.loadProfile(profile);
      const current = readProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY);
      const denominator = readProfileProperty(api, RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY);
      const restoreField = ({ name, currentValue, previousValue, desiredValue, label }) => {
        if (currentValue === previousValue) return false;
        // A failed multi-field apply can leave only one field at Arc Power's
        // target. Treat each field independently: requiring the whole profile
        // to match the desired tuple loses the limiter write when the later
        // denominator write failed. Anything other than our target or the
        // recorded previous value is an external edit, so fail closed.
        if (currentValue !== desiredValue) {
          throw new Error(`RTSS profile changed outside Arc Power; ${label} rollback was not verified`);
        }
        if (previousValue === null
          || !writeProfileProperty(api, name, previousValue)
          || readProfileProperty(api, name) !== previousValue) {
          throw new Error(`${label} rollback could not be verified`);
        }
        return true;
      };
      let changed = false;
      changed = restoreField({
        name: RTSS_FRAME_LIMIT_PROPERTY,
        currentValue: current,
        previousValue: snapshot.previousLimit,
        desiredValue: snapshot.desiredLimit,
        label: 'RTSS FramerateLimit',
      }) || changed;
      changed = restoreField({
        name: RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY,
        currentValue: denominator,
        previousValue: snapshot.previousDenominator,
        desiredValue: snapshot.desiredDenominator,
        label: 'RTSS FramerateLimitDenominator',
      }) || changed;
      if (changed && snapshot.existed) api.saveProfile(profile);
      if (!snapshot.existed && profile !== RTSS_GLOBAL_PROFILE && snapshot.created === true) {
        const removed = deleteProfileVerified(api, profile);
        if (!removed.ok) return { ok: false, error: removed.error };
      }
      // Remove the active marker before attempting flag restoration so the
      // last profile can release RTSS's shared limiter flag. Keep the
      // ownership snapshot until that release is verified; a caller can then
      // retry cleanup with the returned rollback token.
      activeFrameLimitProfiles.delete(profile);
      const hadFlagSnapshot = Boolean(limiterFlagSnapshot);
      const flagStatus = hadFlagSnapshot
        ? restoreLimiterFlagIfIdle(api)
        : { ok: true, restored: true, deferred: false };
      if (!flagStatus.ok) return { ok: false, error: 'RTSS limiter flag rollback was not verified' };
      frameLimitSnapshots.delete(profile);
      return {
        ok: true,
        flagRestored: flagStatus.restored,
        ...(flagStatus.deferred ? { flagRestorationDeferred: true } : {}),
      };
    } catch (error) {
      // The original failure still selects IGCL, but expose cleanupPending so
      // a caller that owns a sidecar does not report a clean fallback while
      // its RTSS state may still contain Arc Power's cap. The snapshot is
      // deliberately retained for a retry.
      activeFrameLimitProfiles.delete(profile);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const applyFrameLimitNow = async ({ enabled = false, value = RTSS_FRAME_LIMIT_RANGE.default, executablePath: targetExecutablePath = null, removeProfile = false, rollbackToken = null } = {}) => {
    const unavailable = await frameLimiterAvailability();
    if (unavailable) return { ...unavailable, used: false, fallback: true };
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
      const beforeFlags = readLimiterFlags(api);
      if (beforeFlags === null) throw new Error('RTSS limiter state could not be read');
      const priorFrameSnapshot = frameLimitSnapshots.get(profile);
      const priorLimiterFlagSnapshot = limiterFlagSnapshot;
      const priorActive = activeFrameLimitProfiles.has(profile);
      const buildRestoreToken = (expectedLimit, expectedDenominator, expectedEnabled) => ({
        profile,
        previousLimit: beforeLimit,
        previousDenominator: beforeDenominator,
        previousEnabled: (beforeFlags & RTSS_LIMITER_DISABLED_FLAG) === 0,
        expectedLimit,
        expectedDenominator,
        expectedEnabled,
        priorFrameSnapshot: priorFrameSnapshot ? { ...priorFrameSnapshot } : null,
        priorLimiterFlagSnapshot: priorLimiterFlagSnapshot ? { ...priorLimiterFlagSnapshot } : null,
        priorActive,
      });

      // Rollback may need to re-enable an exact pre-existing profile after
      // the normal disable path restored its fields. In that narrow case,
      // preserve the recorded denominator instead of treating the request as
      // a fresh cap (fresh caps intentionally normalize their denominator to
      // 1).
      const tokenSnapshot = rollbackToken && typeof rollbackToken === 'object' && rollbackToken.profile === profile
        ? { ...rollbackToken }
        : null;
      const exactRollbackEnable = enabled === true
        && tokenSnapshot?.existed === true
        && beforeLimit === tokenSnapshot.previousLimit
        && (tokenSnapshot.previousDenominator === null || beforeDenominator === tokenSnapshot.previousDenominator);
      if (exactRollbackEnable) {
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
        if (flagsBeforeEnable !== readLimiterFlags(api)) api.updateProfiles();
        return {
          ok: true,
          used: true,
          source: 'rtss',
          profile,
          enabled: true,
          value: requestedLimit,
          changed: false,
          rollbackToken: { profile, ...tokenSnapshot },
          restoreToken: buildRestoreToken(beforeLimit, beforeDenominator, true),
        };
      }

      if (enabled !== true) {
        const snapshot = frameLimitSnapshots.get(profile) ?? tokenSnapshot;
        let changed = false;
        if (profile !== RTSS_GLOBAL_PROFILE && removeProfile === true) {
          // A per-application profile is shared user state. Only delete one
          // when this invocation proved Arc Power created it. A pre-existing
          // profile is restored in place, including its exact denominator.
          // After a restart, missing ownership proof fails closed rather than
          // deleting a profile the user may own.
          if (!snapshot) throw new Error('RTSS ownership snapshot unavailable; profile was not removed');
          const matchesDesired = beforeLimit === snapshot.desiredLimit
            && (snapshot.desiredDenominator === null || beforeDenominator === snapshot.desiredDenominator);
          if (!matchesDesired) throw new Error('RTSS profile changed outside Arc Power; cleanup was not verified');
          if (snapshot.existed === true) {
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
            if (changed) {
              api.saveProfile(profile);
              api.updateProfiles();
            }
            activeFrameLimitProfiles.delete(profile);
            const hadFlagSnapshot = Boolean(limiterFlagSnapshot);
            const flagStatus = hadFlagSnapshot
              ? restoreLimiterFlagIfIdle(api)
              : { ok: true, restored: true, deferred: false };
            if (!flagStatus.ok) throw new Error('RTSS limiter flag rollback was not verified');
            frameLimitSnapshots.delete(profile);
            return {
              ok: true,
              used: true,
              source: 'rtss',
              profile,
              enabled: false,
              value: 0,
              changed,
              removed: true,
              profileDeleted: false,
              restored: true,
              rollbackToken: { profile, ...snapshot },
              restoreToken: buildRestoreToken(
                readProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY),
                readProfileProperty(api, RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY),
                (readLimiterFlags(api) & RTSS_LIMITER_DISABLED_FLAG) === 0,
              ),
              flagRestored: flagStatus.restored,
              ...(flagStatus.deferred ? { flagRestorationDeferred: true } : {}),
            };
          }
          if (snapshot.created === true) {
            const removed = deleteProfileVerified(api, profile);
            if (!removed.ok) throw new Error(removed.error);
            activeFrameLimitProfiles.delete(profile);
            const hadFlagSnapshot = Boolean(limiterFlagSnapshot);
            const flagStatus = hadFlagSnapshot
              ? restoreLimiterFlagIfIdle(api)
              : { ok: true, restored: true, deferred: false };
            if (!flagStatus.ok) throw new Error('RTSS limiter flag rollback was not verified');
            frameLimitSnapshots.delete(profile);
            return {
              ok: true,
              used: true,
              source: 'rtss',
              profile,
              enabled: false,
              value: 0,
              changed: true,
              removed: true,
              profileDeleted: true,
              rollbackToken: { profile, ...snapshot },
              restoreToken: buildRestoreToken(
                readProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY),
                readProfileProperty(api, RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY),
                (readLimiterFlags(api) & RTSS_LIMITER_DISABLED_FLAG) === 0,
              ),
              flagRestored: flagStatus.restored,
              ...(flagStatus.deferred ? { flagRestorationDeferred: true } : {}),
            };
          }
          // No profile was present when Arc Power took its snapshot and no
          // profile creation was observed, so there is nothing safe to delete.
          activeFrameLimitProfiles.delete(profile);
          const hadFlagSnapshot = Boolean(limiterFlagSnapshot);
          const flagStatus = hadFlagSnapshot
            ? restoreLimiterFlagIfIdle(api)
            : { ok: true, restored: true, deferred: false };
          if (!flagStatus.ok) throw new Error('RTSS limiter flag rollback was not verified');
          frameLimitSnapshots.delete(profile);
          return {
            ok: true,
            used: true,
            source: 'rtss',
            profile,
            enabled: false,
            value: 0,
            changed: false,
            removed: true,
            profileDeleted: false,
            rollbackToken: { profile, ...snapshot },
            flagRestored: flagStatus.restored,
            ...(flagStatus.deferred ? { flagRestorationDeferred: true } : {}),
          };
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
        } else if (profile !== RTSS_GLOBAL_PROFILE && snapshot.created === true) {
          const removed = deleteProfileVerified(api, profile);
          if (!removed.ok) throw new Error(removed.error);
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
        }
        activeFrameLimitProfiles.delete(profile);
        const hadFlagSnapshot = Boolean(limiterFlagSnapshot);
        const flagStatus = hadFlagSnapshot
          ? restoreLimiterFlagIfIdle(api)
          : { ok: true, restored: true, deferred: false };
        if (!flagStatus.ok) throw new Error('RTSS limiter flag rollback was not verified');
        if (snapshot && frameLimitSnapshots.has(profile)) frameLimitSnapshots.delete(profile);
          if (changed || flagStatus.restored) api.updateProfiles();
          return {
          ok: true,
          used: true,
          source: 'rtss',
          profile,
          enabled: false,
            value: 0,
            changed,
            restoreToken: buildRestoreToken(
              readProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY),
              readProfileProperty(api, RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY),
              (readLimiterFlags(api) & RTSS_LIMITER_DISABLED_FLAG) === 0,
            ),
            flagRestored: flagStatus.restored,
          ...(flagStatus.deferred ? { flagRestorationDeferred: true } : {}),
        };
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
        if (profile !== RTSS_GLOBAL_PROFILE && snapshot.existed === false) snapshot.created = true;
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
      return {
        ok: true,
        used: true,
        source: 'rtss',
        profile,
        enabled: true,
        value: requestedLimit,
        changed,
        rollbackToken: { profile, ...snapshot },
        restoreToken: buildRestoreToken(requestedLimit, beforeDenominator === null ? null : 1, true),
      };
    } catch (cause) {
      const rollback = rollbackFrameLimitChange(api, profile);
      return {
        ok: false,
        used: false,
        fallback: true,
        source: 'igcl',
        profile,
        ...(removeProfile === true || rollback.ok !== true ? { cleanupPending: true } : {}),
        ...(rollback.ok !== true && rollback.error ? { cleanupError: rollback.error } : {}),
        ...(frameLimitSnapshots.has(profile) ? { rollbackToken: { profile, ...frameLimitSnapshots.get(profile) } } : {}),
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  };

  const restoreFrameLimitNow = async (restoreToken = null) => {
    const unavailable = await frameLimiterAvailability();
    if (unavailable) return { ...unavailable, used: false };
    if (!restoreToken || typeof restoreToken !== 'object' || typeof restoreToken.profile !== 'string') {
      return { ok: false, used: false, error: 'RTSS frame-limit rollback token is unavailable' };
    }
    const api = bindings ?? await resolveBindings();
    if (!api || typeof api.setFlags !== 'function') {
      return { ok: false, used: false, error: 'RTSS frame limiter is unavailable' };
    }
    const profile = restoreToken.profile;
    try {
      api.loadProfile(profile);
      const currentLimit = readProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY);
      const currentDenominator = readProfileProperty(api, RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY);
      const currentFlags = readLimiterFlags(api);
      if (currentLimit === null || currentFlags === null) throw new Error('RTSS frame-limit rollback read-back failed');
      const currentEnabled = (currentFlags & RTSS_LIMITER_DISABLED_FLAG) === 0;
      if (currentLimit !== restoreToken.expectedLimit
        || (restoreToken.expectedDenominator !== null && currentDenominator !== restoreToken.expectedDenominator)
        || (typeof restoreToken.expectedEnabled === 'boolean' && currentEnabled !== restoreToken.expectedEnabled)) {
        throw new Error('RTSS frame-limit rollback refused because the state changed outside Arc Power');
      }
      let changed = false;
      if (restoreToken.previousLimit !== null && currentLimit !== restoreToken.previousLimit) {
        if (!writeProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY, restoreToken.previousLimit)
          || readProfileProperty(api, RTSS_FRAME_LIMIT_PROPERTY) !== restoreToken.previousLimit) {
          throw new Error('RTSS FramerateLimit rollback could not be verified');
        }
        changed = true;
      }
      if (restoreToken.previousDenominator !== null && currentDenominator !== restoreToken.previousDenominator) {
        if (!writeProfileProperty(api, RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY, restoreToken.previousDenominator)
          || readProfileProperty(api, RTSS_FRAME_LIMIT_DENOMINATOR_PROPERTY) !== restoreToken.previousDenominator) {
          throw new Error('RTSS FramerateLimitDenominator rollback could not be verified');
        }
        changed = true;
      }
      let flagChanged = false;
      if (typeof restoreToken.previousEnabled === 'boolean') {
        flagChanged = currentEnabled !== restoreToken.previousEnabled;
        if (!setLimiterEnabled(api, restoreToken.previousEnabled)) {
          throw new Error('RTSS limiter flag rollback could not be verified');
        }
      }
      if (changed) api.saveProfile(profile);
      if (changed || flagChanged) api.updateProfiles();

      // Restore the controller's ownership bookkeeping along with RTSS's
      // persisted state. A failed graphics transaction must not leave a
      // phantom active profile or a stale shared-flag snapshot behind.
      if (restoreToken.priorFrameSnapshot) frameLimitSnapshots.set(profile, { ...restoreToken.priorFrameSnapshot });
      else frameLimitSnapshots.delete(profile);
      if (restoreToken.priorActive === true) activeFrameLimitProfiles.add(profile);
      else activeFrameLimitProfiles.delete(profile);
      limiterFlagSnapshot = restoreToken.priorLimiterFlagSnapshot
        ? { ...restoreToken.priorLimiterFlagSnapshot }
        : null;
      return {
        ok: true,
        used: true,
        source: 'rtss',
        profile,
        restored: true,
        changed,
        flagRestored: true,
      };
    } catch (cause) {
      return {
        ok: false,
        used: true,
        source: 'rtss',
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

  const restoreFrameLimit = (restoreToken = null) => {
    const next = queue.catch(() => {}).then(() => restoreFrameLimitNow(restoreToken));
    queue = next.catch(() => {});
    return next;
  };

  return {
    apply,
    getFrameLimit,
    applyFrameLimit,
    restoreFrameLimit,
    getState: () => cloneState({ ...state, dllPath: loadedPath }),
  };
}
