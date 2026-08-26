// Foreground game -> OC profile lifecycle for executable-keyed Game Profiles.
// The controller owns no persistence. It polls the existing foreground
// detector and sidecar, applies a saved profile on entry, and restores the
// active normal profile when that process exits.

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

/**
 * @param {{
 *   foregroundApi: { detectProcess: () => Promise<{ pid: number, exePath: string } | null> },
 *   gameProfiles: { loadCatalog: () => Promise<{ catalog?: object[], settings?: object[] }> },
 *   store: { loadProfiles: () => Promise<object[]>, loadSettings: () => Promise<object> },
 *   applyProfile: (deviceId: number, settings: object) => Promise<object>,
 *   readCurrent?: (deviceId: number) => Promise<object>,
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
  let lastFailedSignature = null;
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

  const gameTargetFor = (processInfo, snapshot) => {
    const exePath = canonicalExePath(processInfo?.exePath);
    if (!exePath || !snapshot.catalog.some((entry) => entry?.exePath === exePath)) return null;
    const game = snapshot.gameSettings.find((item) => item?.exePath === exePath);
    if (!game || game.enabled !== true || typeof game.tuningProfileId !== 'string') return null;
    const profile = snapshot.profiles.find((item) => item?.id === game.tuningProfileId);
    if (!profile) return null;
    return { exePath, game, profile };
  };

  const normalSettingsFor = async (snapshot) => {
    const normal = snapshot.profiles.find((profile) => profile?.id === snapshot.settings?.activeProfileId);
    if (normal?.settings && typeof normal.settings === 'object') return normal.settings;
    if (deps.readCurrent && snapshot.deviceId !== null) {
      try { return stateToSettings(await deps.readCurrent(snapshot.deviceId)); } catch { /* best effort */ }
    }
    return {};
  };

  const restore = async (record) => {
    let snapshot = null;
    try { snapshot = await loadSnapshot(); } catch { /* use captured normal state */ }
    const deviceId = snapshot?.deviceId ?? record.deviceId;
    const normal = snapshot ? await normalSettingsFor(snapshot) : record.normalSettings;
    if (deviceId !== null && normal && typeof normal === 'object') {
      try { await deps.applyProfile(deviceId, normal); } catch { /* best effort on exit */ }
    }
  };

  const tick = async () => {
    if (stopped) return;
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
        await restore(record);
      } else {
        const nextTarget = gameTargetFor(processInfo, snapshot);
        // The foreground window can move to an unrelated app while the game
        // keeps running. Keep its tuning active until that PID actually exits;
        // only a different configured game should trigger a handoff.
        if (!nextTarget) return;
        if (nextTarget.exePath === active.exePath && processInfo?.pid === active.pid) return;
        const record = active;
        active = null;
        await restore(record);
      }
    }

    const target = gameTargetFor(processInfo, snapshot);
    if (!target || snapshot.deviceId === null) return;
    const signature = json({
      pid: processInfo.pid,
      exePath: target.exePath,
      profileId: target.profile.id,
      updatedAt: target.game.updatedAt,
      deviceId: snapshot.deviceId,
      settings: target.profile.settings,
    });
    if (signature === lastFailedSignature) return;
    const normalSettings = await normalSettingsFor(snapshot);
    try {
      const result = await deps.applyProfile(snapshot.deviceId, target.profile.settings ?? {});
      if (!applySucceeded(result)) {
        lastFailedSignature = signature;
        return;
      }
      lastFailedSignature = null;
      active = {
        pid: processInfo.pid,
        exePath: target.exePath,
        deviceId: snapshot.deviceId,
        normalSettings,
      };
    } catch {
      lastFailedSignature = signature;
    }
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
        await restore(record);
      }
    },
    /** Exposed for deterministic tests and diagnostics. */
    async tick() { await runTick(); },
    getActive() { return active ? { ...active } : null; },
  };
}
