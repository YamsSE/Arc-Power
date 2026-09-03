// Foreground game -> OC profile lifecycle for executable-keyed Game Profiles.
// The controller owns no persistence. It polls the existing foreground
// detector and sidecar, applies every matching per-GPU assignment on entry,
// and restores each target's captured normal profile when that process exits.

import { canonicalExePath } from './store/game-profile-store.js';

const DEFAULT_INTERVAL_MS = 400;

function json(value) {
  try { return JSON.stringify(value); } catch { return ''; }
}

function isProcessAliveDefault(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Windows can deny the probe for a live process. EPERM is a positive
    // liveness answer; all other errors mean the process is gone.
    return err?.code === 'EPERM';
  }
}

function isDeviceKey(value) {
  return typeof value === 'string' && value.length > 0;
}

function deviceKeyMatches(device, key) {
  return isDeviceKey(key) && device?.synthetic !== true && device?.backendKind !== 'os'
    && device?.identityAmbiguous !== true
    && (device?.deviceKey === key || (Array.isArray(device?.deviceKeys) && device.deviceKeys.includes(key)));
}

function stateToSettings(state) {
  if (!state || typeof state !== 'object') return {};
  const out = {};
  for (const key of ['powerLimitW', 'gpuVoltOffsetV', 'gpuFreqOffsetMhz', 'tempLimitC', 'vramFreqOffsetGts', 'vramVoltOffsetV', 'fixedFanPct']) {
    if (typeof state[key] === 'number' && Number.isFinite(state[key])) out[key] = state[key];
  }
  if (state.gpuLock && typeof state.gpuLock === 'object'
    && Number.isFinite(state.gpuLock.voltageV) && Number.isFinite(state.gpuLock.freqMhz)) {
    out.gpuLock = { voltageV: state.gpuLock.voltageV, freqMhz: state.gpuLock.freqMhz };
  }
  if (Array.isArray(state.vfCurve)) out.vfCurve = state.vfCurve;
  if (state.fanMode === 'auto' || state.fanMode === 'curve' || state.fanMode === 'fixed') out.fanMode = state.fanMode;
  if (Array.isArray(state.fanCurve)) out.fanCurve = state.fanCurve;
  return out;
}

function applySucceeded(result) {
  if (result && result.result && result.result.ok === false) return false;
  if (result && result.ok === false) return false;
  return true;
}

function profileIdOf(value) {
  return typeof value === 'string' && /^\S+$/.test(value) ? value : null;
}

/**
 * Convert both the current legacy record and the new per-GPU shape into
 * assignment descriptors. An explicit non-empty gpuProfiles array owns the
 * record; the legacy fields are used only when that array is absent/empty.
 */
function assignmentsOf(game) {
  if (Array.isArray(game?.gpuProfiles) && game.gpuProfiles.length > 0) {
    return game.gpuProfiles.map((assignment) => ({
      deviceKey: isDeviceKey(assignment?.deviceKey) ? assignment.deviceKey : null,
      enabled: assignment?.enabled === true,
      tuningProfileId: profileIdOf(assignment?.tuningProfileId),
      legacyFallback: assignment?.deviceKey == null,
    }));
  }
  return [{
    deviceKey: null,
    enabled: game?.enabled === true,
    tuningProfileId: profileIdOf(game?.tuningProfileId),
    legacyFallback: true,
  }];
}

function profileCanApplyToAssignment(profile, assignment, target) {
  const profileKey = isDeviceKey(profile?.deviceKey) ? profile.deviceKey : null;
  if (assignment.deviceKey !== null) {
    // The assignment itself is the explicit target for a legacy/unkeyed
    // profile. A keyed profile, however, can only run on its own adapter.
    return profileKey === null || profileKey === assignment.deviceKey || deviceKeyMatches(target, profileKey);
  }
  // Unkeyed profiles remain usable through the old persisted-deviceId path.
  // A keyed legacy assignment is accepted only when its profile is keyed to
  // the same physical target; it must never cross-apply to another adapter.
  return profileKey === null || deviceKeyMatches(target, profileKey);
}

/**
 * @param {{
 *   foregroundApi: { detectProcess: () => Promise<{ pid: number, exePath: string } | null> },
 *   gameProfiles: { loadCatalog: () => Promise<{ catalog?: object[], settings?: object[] }> },
 *   store: { loadProfiles: () => Promise<object[]>, loadSettings: () => Promise<object> },
 *   applyProfile: (deviceId: number, settings: object) => Promise<object>,
 *   readCurrent?: (deviceId: number) => Promise<object>,
 *   listDevices?: () => Promise<Array<{ id: number, deviceKey?: string }>>,
 *   isProcessAlive?: (pid: number) => boolean,
 *   intervalMs?: number,
 * }} deps
 */
export function createGameTuningController(deps) {
  const intervalMs = Number.isFinite(deps?.intervalMs) ? Math.max(100, Math.round(deps.intervalMs)) : DEFAULT_INTERVAL_MS;
  const isProcessAlive = deps?.isProcessAlive ?? isProcessAliveDefault;
  let timer = null;
  let stopped = false;
  let active = null;
  let pendingRestore = null;
  let failedAttempt = null;
  let inFlight = null;

  const loadSnapshot = async () => {
    const [catalog, profiles, settings] = await Promise.all([
      deps.gameProfiles.loadCatalog(),
      deps.store.loadProfiles(),
      deps.store.loadSettings(),
    ]);
    const deviceId = Number.isInteger(settings?.deviceId) && settings.deviceId >= 0 ? settings.deviceId : null;
    return {
      catalog: Array.isArray(catalog?.catalog) ? catalog.catalog : [],
      gameSettings: Array.isArray(catalog?.settings) ? catalog.settings : [],
      profiles: Array.isArray(profiles) ? profiles : [],
      settings: settings ?? {},
      deviceId,
    };
  };

  const resolveAssignmentTargets = async (game, snapshot) => {
    const assignments = assignmentsOf(game);
    const needsInventory = assignments.some((assignment) => assignment.deviceKey !== null)
      || typeof deps.listDevices === 'function';
    let devices = null;
    if (needsInventory && typeof deps.listDevices === 'function') {
      try {
        const listed = await deps.listDevices();
        devices = Array.isArray(listed) ? listed : [];
      } catch {
        // A keyed assignment cannot be resolved without a current physical
        // inventory. It is skipped below rather than falling back by ordinal.
        devices = null;
      }
    }

    const targets = [];
    for (const assignment of assignments) {
      if (!assignment.enabled || assignment.tuningProfileId === null) continue;
      let target = null;
      if (assignment.deviceKey !== null) {
        if (!devices) continue;
        const matches = devices.filter((device) => deviceKeyMatches(device, assignment.deviceKey));
        // Exact physical identity is mandatory. Missing keys and collisions
        // are both fail-closed; device order is never a tie-breaker.
        if (matches.length !== 1 || !Number.isInteger(matches[0]?.id) || matches[0].id < 0) continue;
        target = {
          deviceId: matches[0].id,
          deviceKey: isDeviceKey(matches[0].deviceKey) ? matches[0].deviceKey : assignment.deviceKey,
          deviceKeys: Array.isArray(matches[0].deviceKeys) ? matches[0].deviceKeys : null,
        };
      } else if (snapshot.deviceId !== null) {
        const listed = devices?.find((device) => device?.id === snapshot.deviceId) ?? null;
        target = {
          deviceId: snapshot.deviceId,
          deviceKey: isDeviceKey(listed?.deviceKey)
            ? listed.deviceKey
            : (isDeviceKey(snapshot.settings?.deviceKey) ? snapshot.settings.deviceKey : null),
          deviceKeys: Array.isArray(listed?.deviceKeys) ? listed.deviceKeys : null,
        };
      }
      if (!target) continue;
      const dedupeKey = isDeviceKey(target.deviceKey) ? `key:${target.deviceKey}` : `id:${target.deviceId}`;
      const existingIndex = targets.findIndex((item) => {
        const itemKey = isDeviceKey(item.deviceKey) ? `key:${item.deviceKey}` : `id:${item.deviceId}`;
        return itemKey === dedupeKey;
      });
      if (existingIndex < 0) {
        targets.push({ assignment, ...target });
      } else if (assignment.deviceKey !== null && targets[existingIndex].assignment.deviceKey === null) {
        // A keyed assignment wins when the migrated null-key fallback lands
        // on the same physical adapter.
        targets[existingIndex] = { assignment, ...target };
      }
    }
    return targets;
  };

  const gameTargetsFor = async (processInfo, snapshot) => {
    const exePath = canonicalExePath(processInfo?.exePath);
    if (!exePath || !snapshot.catalog.some((entry) => entry?.exePath === exePath)) return [];
    const game = snapshot.gameSettings.find((item) => item?.exePath === exePath);
    if (!game) return [];
    const candidates = await resolveAssignmentTargets(game, snapshot);
    return candidates.flatMap((target) => {
      const profile = snapshot.profiles.find((item) => item?.id === target.assignment.tuningProfileId);
      if (!profile || !profileCanApplyToAssignment(profile, target.assignment, target)) return [];
      return [{ exePath, game, profile, ...target }];
    });
  };

  const normalSettingsFor = async (target, snapshot) => {
    const activeMap = snapshot.settings?.activeProfileIds;
    const mappedId = isDeviceKey(target.deviceKey) && activeMap && typeof activeMap === 'object' && !Array.isArray(activeMap)
      ? profileIdOf(activeMap[target.deviceKey])
      : null;
    const scalarId = profileIdOf(snapshot.settings?.activeProfileId);
    const candidateIds = [...new Set([mappedId, scalarId].filter(Boolean))];
    for (const profileId of candidateIds) {
      const profile = snapshot.profiles.find((item) => item?.id === profileId);
      if (!profile || !profile?.settings || typeof profile.settings !== 'object') continue;
      const profileKey = isDeviceKey(profile.deviceKey) ? profile.deviceKey : null;
      if (profileKey !== null && !deviceKeyMatches(target, profileKey)) continue;
      return profile.settings;
    }
    if (deps.readCurrent) {
      try { return stateToSettings(await deps.readCurrent(target.deviceId)); } catch { /* best effort */ }
    }
    return {};
  };

  const restore = async (record) => {
    // Restore each successful target even when another adapter's restore
    // throws. The captured payload is intentional: it represents the normal
    // state that existed immediately before this game session took over.
    const remaining = [];
    for (const target of record?.targets ?? []) {
      try {
        const result = await deps.applyProfile(target.deviceId, target.normalSettings);
        if (!applySucceeded(result)) remaining.push(target);
      } catch { remaining.push(target); }
    }
    return remaining;
  };

  const signatureOf = (processInfo, targets) => json({
    pid: processInfo?.pid,
    exePath: targets[0]?.exePath ?? canonicalExePath(processInfo?.exePath),
    assignments: targets.map((target) => ({
      deviceId: target.deviceId,
      deviceKey: target.deviceKey,
      profileId: target.profile.id,
      updatedAt: target.game.updatedAt,
      settings: target.profile.settings,
    })),
  });

  const tick = async () => {
    if (stopped) return;
    if (pendingRestore) {
      const remaining = await restore(pendingRestore);
      if (remaining.length > 0) {
        pendingRestore = { ...pendingRestore, targets: remaining };
        return;
      }
      pendingRestore = null;
    }
    let processInfo = null;
    let snapshot;
    try {
      snapshot = await loadSnapshot();
      processInfo = await deps.foregroundApi.detectProcess();
    } catch {
      return;
    }

    if (active) {
      if (!isProcessAlive(active.pid)) {
        const record = active;
        active = null;
        const remaining = await restore(record);
        if (remaining.length > 0) {
          pendingRestore = { ...record, targets: remaining };
          return;
        }
      } else {
        const nextTargets = await gameTargetsFor(processInfo, snapshot);
        const foregroundExePath = canonicalExePath(processInfo?.exePath);
        const sameProcess = foregroundExePath === active.exePath && processInfo?.pid === active.pid;
        const nextSignature = sameProcess && nextTargets.length > 0 ? signatureOf(processInfo, nextTargets) : null;
        if (sameProcess && nextSignature === active.signature) return;
        // An unrelated foreground app does not end a live game session. A
        // configured game handoff, or a changed/disabled assignment for the
        // same process, must restore before the next apply.
        if (!sameProcess && nextTargets.length === 0) return;
        const record = active;
        active = null;
        const remaining = await restore(record);
        if (remaining.length > 0) {
          pendingRestore = { ...record, targets: remaining };
          return;
        }
        failedAttempt = null;
      }
    }

    const targets = await gameTargetsFor(processInfo, snapshot);
    if (targets.length === 0) return;
    const signature = signatureOf(processInfo, targets);
    if (failedAttempt?.signature === signature && failedAttempt.retryUsed) return;

    const attempted = [];
    const prepared = [];
    let applyFailed = false;
    for (const target of targets) {
      const normalSettings = await normalSettingsFor(target, snapshot);
      const attemptedTarget = {
        deviceId: target.deviceId,
        deviceKey: target.deviceKey,
        normalSettings,
      };
      attempted.push(attemptedTarget);
      try {
        const result = await deps.applyProfile(target.deviceId, target.profile.settings ?? {});
        if (!applySucceeded(result)) {
          applyFailed = true;
          continue;
        }
        prepared.push(attemptedTarget);
      } catch {
        // One failed adapter must not prevent independent assignments from
        // being attempted on the remaining physical adapters.
        applyFailed = true;
      }
    }
    if (applyFailed) {
      // A failed driver call may have changed part of its target before
      // returning an error. Restore every attempted adapter, including
      // successful independent adapters, before exposing a retryable failure.
      const remaining = await restore({ targets: attempted });
      if (remaining.length > 0) {
        pendingRestore = { pid: processInfo.pid, exePath: targets[0].exePath, signature, targets: remaining };
      }
      const retryUsed = failedAttempt?.signature === signature;
      failedAttempt = { signature, retryUsed };
      return;
    }
    failedAttempt = null;
    active = {
      pid: processInfo.pid,
      exePath: targets[0].exePath,
      // Retain the legacy single-target fields for diagnostics/tests.
      deviceId: prepared[0].deviceId,
      normalSettings: prepared[0].normalSettings,
      targets: prepared,
      signature,
    };
  };

  const runTick = () => {
    if (inFlight) return inFlight;
    inFlight = tick().catch(() => {}).finally(() => { inFlight = null; });
    return inFlight;
  };

  return {
    start() {
      if (timer || stopped) return;
      stopped = false;
      timer = setInterval(() => { void runTick(); }, intervalMs);
      void runTick();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (inFlight) await inFlight;
      if (active) {
        const record = active;
        active = null;
        const remaining = await restore(record);
        if (remaining.length > 0) pendingRestore = { ...record, targets: remaining };
      }
      if (pendingRestore) {
        const record = pendingRestore;
        pendingRestore = null;
        await restore(record);
      }
      if (pendingRestore) {
        const remaining = await restore(pendingRestore);
        pendingRestore = remaining.length > 0 ? { ...pendingRestore, targets: remaining } : null;
      }
    },
    /** Exposed for deterministic tests and diagnostics. */
    async tick() { await runTick(); },
    getActive() { return active ? { ...active } : null; },
  };
}
