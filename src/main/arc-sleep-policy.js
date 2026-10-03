const DEFAULTS = Object.freeze({
  idleEnabled: false,
  adaptiveEnabled: false,
  idleAfterSeconds: 300,
  idleFps: 30,
  adaptiveMinFps: 60,
  adaptiveMaxFps: 144,
  adaptiveTargetLoadPct: 85
});

const LIMITS = Object.freeze({
  idleAfterSeconds: [60, 3600],
  idleFps: [15, 120],
  adaptiveMinFps: [30, 240],
  adaptiveMaxFps: [31, 500],
  adaptiveTargetLoadPct: [50, 99]
});

function boundedInteger(value, [minimum, maximum], fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

export const ARC_SLEEP_DEFAULTS = DEFAULTS;

export function normalizeArcSleepSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const normalized = {
    idleEnabled: source.idleEnabled === true,
    adaptiveEnabled: source.adaptiveEnabled === true,
    idleAfterSeconds: boundedInteger(source.idleAfterSeconds, LIMITS.idleAfterSeconds, DEFAULTS.idleAfterSeconds),
    idleFps: boundedInteger(source.idleFps, LIMITS.idleFps, DEFAULTS.idleFps),
    adaptiveMinFps: boundedInteger(source.adaptiveMinFps, LIMITS.adaptiveMinFps, DEFAULTS.adaptiveMinFps),
    adaptiveMaxFps: boundedInteger(source.adaptiveMaxFps, LIMITS.adaptiveMaxFps, DEFAULTS.adaptiveMaxFps),
    adaptiveTargetLoadPct: boundedInteger(source.adaptiveTargetLoadPct, LIMITS.adaptiveTargetLoadPct, DEFAULTS.adaptiveTargetLoadPct)
  };

  if (normalized.adaptiveMinFps >= normalized.adaptiveMaxFps) {
    normalized.adaptiveMinFps = DEFAULTS.adaptiveMinFps;
    normalized.adaptiveMaxFps = DEFAULTS.adaptiveMaxFps;
  }
  return normalized;
}

export function createArcSleepPolicyState(settings = DEFAULTS) {
  const normalized = normalizeArcSleepSettings(settings);
  return {
    adaptiveCapFps: normalized.adaptiveMaxFps,
    aboveTargetSamples: 0,
    belowTargetSamples: 0,
    loadUnavailableSinceMs: null,
    observedFpsSamples: [],
    observedProcessId: null,
    seededProcessIds: []
  };
}

function validLoad(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function validClock(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function validObservedFps(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1000 ? value : null;
}

function validProcessId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Advances Arc Sleep's combined idle/adaptive policy by one supplied sample.
 * sample: { idleMs, loadPercent, nowMs, observedFps, observedProcessId }. Invalid idleMs is treated as active;
 * invalid loadPercent is treated as unavailable. No clocks or timers are read.
 */
export function stepArcSleepPolicy(state, settings, sample = {}) {
  const config = normalizeArcSleepSettings(settings);
  const current = state && typeof state === 'object' ? state : createArcSleepPolicyState(config);
  const nowMs = validClock(sample?.nowMs);
  const idleMs = typeof sample?.idleMs === 'number' && Number.isFinite(sample.idleMs) && sample.idleMs >= 0
    ? sample.idleMs
    : null;
  const loadPercent = validLoad(sample?.loadPercent);
  const idleActive = config.idleEnabled && idleMs !== null && idleMs >= config.idleAfterSeconds * 1000;

  let adaptiveCapFps = boundedInteger(current.adaptiveCapFps, LIMITS.adaptiveMaxFps, config.adaptiveMaxFps);
  adaptiveCapFps = Math.min(config.adaptiveMaxFps, Math.max(config.adaptiveMinFps, adaptiveCapFps));
  let aboveTargetSamples = Number.isInteger(current.aboveTargetSamples) && current.aboveTargetSamples >= 0
    ? current.aboveTargetSamples
    : 0;
  let belowTargetSamples = Number.isInteger(current.belowTargetSamples) && current.belowTargetSamples >= 0
    ? current.belowTargetSamples
    : 0;
  let loadUnavailableSinceMs = validClock(current.loadUnavailableSinceMs);
  let observedFpsSamples = Array.isArray(current.observedFpsSamples)
    ? current.observedFpsSamples.filter((value) => validObservedFps(value) !== null).slice(-2)
    : [];
  let observedProcessId = validProcessId(current.observedProcessId);
  const seededProcessIds = Array.isArray(current.seededProcessIds)
    ? current.seededProcessIds.filter((value) => validProcessId(value) !== null)
    : [];

  if (loadPercent !== null) {
    loadUnavailableSinceMs = null;
    if (loadPercent > config.adaptiveTargetLoadPct + 5) {
      aboveTargetSamples += 1;
      belowTargetSamples = 0;
      const processId = validProcessId(sample?.observedProcessId);
      const observedFps = validObservedFps(sample?.observedFps);
      if (idleActive || processId === null || observedFps === null || seededProcessIds.includes(processId)) {
        observedFpsSamples = [];
        observedProcessId = null;
      } else {
        observedFpsSamples = processId === observedProcessId ? [...observedFpsSamples, observedFps] : [observedFps];
        observedProcessId = processId;
      }
      if (aboveTargetSamples >= 3) {
        if (observedFpsSamples.length >= 3 && observedProcessId !== null) {
          const sortedFps = [...observedFpsSamples].sort((a, b) => a - b);
          const medianFps = sortedFps[1];
          if (sortedFps[2] - sortedFps[0] <= Math.max(5, medianFps * 0.15)
            && medianFps <= adaptiveCapFps - 10) {
            adaptiveCapFps = Math.max(config.adaptiveMinFps, Math.min(adaptiveCapFps, Math.round(medianFps)));
            seededProcessIds.push(observedProcessId);
          }
        }
        adaptiveCapFps = Math.max(config.adaptiveMinFps, adaptiveCapFps - 5);
        aboveTargetSamples = 0;
        observedFpsSamples = [];
        observedProcessId = null;
      }
    } else if (loadPercent < config.adaptiveTargetLoadPct - 5) {
      belowTargetSamples += 1;
      aboveTargetSamples = 0;
      observedFpsSamples = [];
      observedProcessId = null;
      if (belowTargetSamples >= 5) {
        adaptiveCapFps = Math.min(config.adaptiveMaxFps, adaptiveCapFps + 3);
        belowTargetSamples = 0;
      }
    } else {
      aboveTargetSamples = 0;
      belowTargetSamples = 0;
      observedFpsSamples = [];
      observedProcessId = null;
    }
  } else {
    aboveTargetSamples = 0;
    belowTargetSamples = 0;
    observedFpsSamples = [];
    observedProcessId = null;
    if (loadUnavailableSinceMs === null && nowMs !== null) loadUnavailableSinceMs = nowMs;
    if (loadUnavailableSinceMs !== null && nowMs !== null && nowMs < loadUnavailableSinceMs) {
      loadUnavailableSinceMs = nowMs;
    }
  }

  let adaptiveTargetFps = null;
  if (config.adaptiveEnabled) {
    if (loadPercent !== null) adaptiveTargetFps = adaptiveCapFps;
    else if (nowMs !== null && loadUnavailableSinceMs !== null && nowMs - loadUnavailableSinceMs < 5000) {
      adaptiveTargetFps = adaptiveCapFps;
    }
  }

  const targetFps = idleActive ? config.idleFps : adaptiveTargetFps;
  const nextState = { adaptiveCapFps, aboveTargetSamples, belowTargetSamples, loadUnavailableSinceMs, observedFpsSamples, observedProcessId, seededProcessIds };

  return {
    state: nextState,
    targetFps,
    source: idleActive ? 'idle' : (adaptiveTargetFps === null ? null : 'adaptive'),
    idleActive,
    adaptiveTargetFps
  };
}
