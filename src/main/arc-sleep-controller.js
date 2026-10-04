import {
  ARC_SLEEP_DEFAULTS,
  createArcSleepPolicyState,
  normalizeArcSleepSettings,
  stepArcSleepPolicy,
} from './arc-sleep-policy.js';

const DEFAULT_BASE_FPS = 60;
const RTSS_FRAME_LIMIT_MIN = 1;
const RTSS_FRAME_LIMIT_MAX = 1000;

function normalizeBaseFrameLimit(value) {
  if (!value || typeof value !== 'object') return null;
  const number = Number(value.value);
  return {
    enabled: value.enabled === true,
    value: Number.isFinite(number)
      ? Math.max(RTSS_FRAME_LIMIT_MIN, Math.min(RTSS_FRAME_LIMIT_MAX, Math.round(number)))
      : DEFAULT_BASE_FPS,
  };
}

function rawState(value) {
  if (!value || typeof value !== 'object'
    || !Number.isInteger(value.limit) || value.limit < 0
    || !Number.isInteger(value.denominator) || value.denominator < 0
    || typeof value.limiterEnabled !== 'boolean') return null;
  return { limit: value.limit, denominator: value.denominator, limiterEnabled: value.limiterEnabled };
}

function sameState(left, right) {
  return left?.limit === right?.limit
    && left?.denominator === right?.denominator
    && left?.limiterEnabled === right?.limiterEnabled;
}

function validRoute(value) {
  if (value == null) return { source: 'rtss' };
  if (value.source === 'rtss') return { source: 'rtss' };
  if (value?.source === 'igcl' && typeof value.deviceKey === 'string' && value.deviceKey.length > 0) {
    return { source: 'igcl', deviceKey: value.deviceKey };
  }
  return null;
}

function normalizeRoute(value) {
  return validRoute(value) ?? { source: 'rtss' };
}

function sameRoute(left, right) {
  const a = normalizeRoute(left);
  const b = normalizeRoute(right);
  return a.source === b.source && (a.source !== 'igcl' || a.deviceKey === b.deviceKey);
}

function validJournal(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) return null;
  const baseline = rawState(value.baseline);
  const underlay = rawState(value.underlay) ?? baseline;
  const expected = rawState(value.expected);
  const route = validRoute(value.route);
  if (!baseline || !underlay || !expected || !route) return null;
  let pending = null;
  if (value.pending != null) {
    const from = rawState(value.pending.from);
    const to = rawState(value.pending.to);
    if (!from || !to) return null;
    pending = { from, to };
  }
  return {
    version: 1,
    baseline,
    underlay,
    expected,
    route,
    pending,
    ...(value.externalChange === true ? { externalChange: true } : {}),
  };
}

function transitionStates(from, to) {
  const states = [
    from,
    { ...from, limit: to.limit },
    { ...from, limit: to.limit, denominator: to.denominator },
    to,
  ];
  const seen = new Set();
  return states.filter((state) => {
    const key = [state.limit, state.denominator, state.limiterEnabled].join('/');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function asPercentage(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function createQueue() {
  let tail = Promise.resolve();
  return (operation) => {
    const next = tail.then(operation, operation);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
}

/**
 * Owns Arc Sleep's RTSS/selected-adapter FPS cap and serializes it with Graphics apply.
 * withTransaction must wrap the full graphics transaction, including its
 * driver apply and rollback.
 */
export function createArcSleepController({
  store,
  rtssFrameLimiter,
  igclFrameLimiter = null,
  getIdleSeconds = () => null,
  getLoadSignals = async () => null,
  getObservedFps = async () => null,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  intervalMs = 1000,
  rtssOperationTimeoutMs = 5000,
  shutdownTimeoutMs = 5000,
} = {}) {
  const enqueue = createQueue();
  let settings = { ...ARC_SLEEP_DEFAULTS };
  let baseFrameLimit = null;
  let journal = null;
  let invalidJournal = false;
  let pendingBaseDisable = false;
  let pendingBaseDisableExpected = null;
  let policyState = createArcSleepPolicyState(settings);
  let policySource = null;
  let status = 'ready';
  let message = null;
  let rtssAvailable = false;
  let limiterRoute = null;
  let limiterDeviceName = null;
  let frameLimitRange = null;
  let frameLimitLiveChange = false;
  let lastRawState = null;
  let lastKnownRawState = null;
  let runtimeDiagnostics = {
    gpuUtilPct: null,
    reportedFps: null,
    fpsStatus: 'disabled',
    lastFastAdjustmentAtMs: null,
  };
  let timer = null;
  let tickPending = null;
  let initialized = false;
  let stopping = false;

  const hasPolicy = () => settings.idleEnabled || settings.adaptiveEnabled;
  const errorText = (fallback, error) => error instanceof Error ? error.message : (error ? String(error) : fallback);
  const limiterName = (route = journal?.route ?? limiterRoute) => normalizeRoute(route).source.toUpperCase();

  const persistArcSleep = async (patch) => {
    if (typeof store?.saveArcSleepState === 'function') {
      await store.saveArcSleepState(patch);
      return;
    }
    const current = await store.loadSettings();
    await store.saveSettings({ ...current, ...patch });
  };

  const readFromRoute = async (route) => {
    const normalizedRoute = normalizeRoute(route);
    try {
      const result = normalizedRoute.source === 'igcl'
        ? await igclFrameLimiter?.getFrameLimit?.(normalizedRoute.deviceKey)
        : await rtssFrameLimiter?.getFrameLimit?.();
      if (normalizedRoute.source === 'igcl' && result?.deviceKey !== normalizedRoute.deviceKey) return null;
      const state = result?.ok === true
        ? rawState({ limit: result.limit, denominator: result.denominator ?? 1, limiterEnabled: result.limiterEnabled })
        : null;
      if (!state) return null;
      limiterRoute = normalizedRoute;
      limiterDeviceName = typeof result.deviceName === 'string' ? result.deviceName : null;
      rtssAvailable = normalizedRoute.source === 'rtss';
      frameLimitRange = result.frameLimitRange ?? (normalizedRoute.source === 'rtss'
        ? { min: RTSS_FRAME_LIMIT_MIN, max: RTSS_FRAME_LIMIT_MAX, step: 1 }
        : null);
      frameLimitLiveChange = normalizedRoute.source === 'rtss' || result.liveChange === true;
      lastRawState = state;
      lastKnownRawState = state;
      return state;
    } catch {
      return null;
    }
  };

  const readRawState = async (requestedRoute = null, { preferCurrent = false, deviceKey = null } = {}) => {
    const route = requestedRoute ?? (!preferCurrent && journal?.route ? journal.route : null);
    if (route) {
      const state = await readFromRoute(route);
      if (!state) {
        if (normalizeRoute(route).source === 'rtss') rtssAvailable = false;
        lastRawState = null;
      }
      return state;
    }
    if (typeof rtssFrameLimiter?.getFrameLimit === 'function') {
      const rtss = await readFromRoute({ source: 'rtss' });
      if (rtss) return rtss;
    }
    let igcl = null;
    try { igcl = await igclFrameLimiter?.getFrameLimit?.(deviceKey); } catch { igcl = null; }
    if (igcl?.ok === true) {
      if (deviceKey && igcl.deviceKey !== deviceKey) return null;
      const selectedKey = typeof igcl.deviceKey === 'string' ? igcl.deviceKey : deviceKey;
      if (!selectedKey) return null;
      const state = rawState({ limit: igcl.limit, denominator: igcl.denominator ?? 1, limiterEnabled: igcl.limiterEnabled });
      if (!state) return null;
      limiterRoute = { source: 'igcl', deviceKey: selectedKey };
      limiterDeviceName = typeof igcl.deviceName === 'string' ? igcl.deviceName : null;
      rtssAvailable = false;
      frameLimitRange = igcl.frameLimitRange ?? null;
      frameLimitLiveChange = igcl.liveChange === true;
      lastRawState = state;
      lastKnownRawState = state;
      return state;
    }
    rtssAvailable = false;
    lastRawState = null;
    frameLimitRange = null;
    frameLimitLiveChange = false;
    limiterDeviceName = null;
    limiterRoute = null;
    return null;
  };

  const readUnderlayState = async (fallback, route = limiterRoute) => {
    if (normalizeRoute(route).source === 'igcl') return fallback;
    if (typeof rtssFrameLimiter?.getFrameLimitOwnership !== 'function') return fallback;
    try {
      const result = await rtssFrameLimiter.getFrameLimitOwnership();
      return result?.ok === true ? rawState(result.underlay) ?? fallback : fallback;
    } catch {
      return fallback;
    }
  };

  const readDisableTargetState = async (fallback, route = limiterRoute) => {
    if (normalizeRoute(route).source === 'igcl') return fallback;
    if (typeof rtssFrameLimiter?.getFrameLimitOwnership !== 'function') return fallback;
    try {
      const result = await rtssFrameLimiter.getFrameLimitOwnership();
      return result?.ok === true ? rawState(result.disableState) ?? fallback : fallback;
    } catch {
      return fallback;
    }
  };

  const applyFrameLimitOnRoute = async (route, request) => {
    const normalizedRoute = normalizeRoute(route ?? limiterRoute);
    if (normalizedRoute.source === 'igcl') {
      if (typeof igclFrameLimiter?.applyFrameLimit !== 'function') {
        return { ok: false, unavailable: true, error: 'IGCL frame limiter is unavailable' };
      }
      return igclFrameLimiter.applyFrameLimit({
        ...request,
        deviceKey: normalizedRoute.deviceKey,
      });
    }
    if (typeof rtssFrameLimiter?.applyFrameLimit !== 'function') {
      return { ok: false, unavailable: true, error: 'RTSS frame limiter is unavailable' };
    }
    return rtssFrameLimiter.applyFrameLimit(request);
  };

  const writeCap = async (expectedState, targetFps, { automatic = false } = {}) => {
    const route = normalizeRoute(journal?.route ?? limiterRoute);
    let result;
    try {
      result = await applyFrameLimitOnRoute(route, {
        enabled: true,
        value: targetFps,
        expectedState,
        automatic,
      });
    } catch (error) {
      return { ok: false, error: errorText(`${route.source.toUpperCase()} cap apply failed`, error) };
    }
    if (result?.conflict === true || result?.errorCode === 'external-change') {
      return { ok: false, conflict: true, error: result.error ?? `${route.source.toUpperCase()} frame-limit state changed outside Arc Power` };
    }
    if (result?.ok !== true || result?.used !== true) {
      return {
        ok: false,
        unavailable: result?.available === false || result?.errorCode === 'unavailable',
        elevationRequired: result?.errorCode === 'elevation-required',
        error: result?.error ?? `${route.source.toUpperCase()} did not apply the Arc Sleep cap`,
      };
    }
    const observed = await readRawState(route);
    const requested = rawState(result.observedState) ?? { limit: targetFps, denominator: 1, limiterEnabled: true };
    if (!observed || !sameState(observed, requested) || observed.limiterEnabled !== true) {
      return { ok: false, error: `${route.source.toUpperCase()} cap read-back did not match Arc Sleep target`, observed };
    }
    return { ok: true, observed, route };
  };

  const restoreState = async (expectedState, targetState, { retainOwnership = baseFrameLimit?.enabled === true, route = journal?.route ?? limiterRoute, automatic = true } = {}) => {
    const normalizedRoute = normalizeRoute(route);
    try {
      const result = normalizedRoute.source === 'igcl'
        ? await igclFrameLimiter?.restoreFrameLimitState?.({
          expectedState,
          state: targetState,
          deviceKey: normalizedRoute.deviceKey,
          automatic,
        })
        : await rtssFrameLimiter?.restoreFrameLimitState?.({ expectedState, state: targetState, retainOwnership });
      if (!result) return { ok: false, unavailable: true, error: `${normalizedRoute.source.toUpperCase()} recovery support is unavailable` };
      if (result?.conflict === true || result?.errorCode === 'external-change') {
        return { ok: false, conflict: true, error: result.error ?? `${normalizedRoute.source.toUpperCase()} frame-limit state changed outside Arc Power` };
      }
      if (result?.ok !== true) {
        return { ok: false, unavailable: result?.errorCode === 'unavailable' || result?.errorCode === 'elevation-required', error: result?.error ?? `${normalizedRoute.source.toUpperCase()} state restoration failed` };
      }
      const observed = rawState(result.observedState) ?? await readRawState(normalizedRoute);
      const fieldsMatch = observed?.limit === targetState.limit && observed?.denominator === targetState.denominator;
      const flagMatches = observed?.limiterEnabled === targetState.limiterEnabled
        || (result.flagRestorationDeferred === true && observed?.limiterEnabled === true);
      if (!fieldsMatch || !flagMatches) return { ok: false, error: `${normalizedRoute.source.toUpperCase()} recovery read-back did not match the saved baseline`, observed };
      limiterRoute = normalizedRoute;
      rtssAvailable = normalizedRoute.source === 'rtss';
      lastRawState = observed;
      lastKnownRawState = observed;
      return { ok: true, observed, flagRestorationDeferred: result.flagRestorationDeferred === true };
    } catch (error) {
      return { ok: false, error: errorText('RTSS state restoration failed', error) };
    }
  };

  const saveJournal = async (nextJournal) => {
    const clean = validJournal({ ...nextJournal, route: nextJournal?.route ?? limiterRoute });
    if (!clean) throw new Error('Arc Sleep recovery journal is invalid');
    await persistArcSleep({ arcSleepJournal: clean });
    journal = clean;
  };

  const baseFromRawState = (state) => ({
    enabled: state.limiterEnabled && state.limit > 0,
    value: state.limit > 0
      ? Math.max(RTSS_FRAME_LIMIT_MIN, Math.min(RTSS_FRAME_LIMIT_MAX, state.limit))
      : DEFAULT_BASE_FPS,
  });

  const ensureBaseFrameLimit = async (fallbackState) => {
    if (baseFrameLimit) return;
    const source = journal?.baseline ?? fallbackState;
    if (!source) return;
    baseFrameLimit = baseFromRawState(source);
    await persistArcSleep({ arcSleepFrameLimitBase: baseFrameLimit });
  };

  const saveBaseAndJournal = async (
    nextBase,
    nextJournal,
    nextPendingBaseDisable = pendingBaseDisable,
    nextPendingBaseDisableExpected = pendingBaseDisableExpected,
  ) => {
    const cleanBase = normalizeBaseFrameLimit(nextBase);
    const cleanJournal = nextJournal == null ? null : validJournal({ ...nextJournal, route: nextJournal?.route ?? limiterRoute });
    const cleanPendingExpected = rawState(nextPendingBaseDisableExpected);
    if (nextJournal != null && !cleanJournal) throw new Error('Arc Sleep recovery journal is invalid');
    await persistArcSleep({
      arcSleepFrameLimitBase: cleanBase,
      arcSleepJournal: cleanJournal,
      arcSleepPendingBaseDisable: nextPendingBaseDisable === true,
      arcSleepPendingBaseDisableExpected: nextPendingBaseDisable === true ? cleanPendingExpected : null,
    });
    baseFrameLimit = cleanBase;
    journal = cleanJournal;
    pendingBaseDisable = nextPendingBaseDisable === true;
    pendingBaseDisableExpected = pendingBaseDisable ? cleanPendingExpected : null;
  };

  const applyBaseDisable = async (current, baseSetting, { automatic = false } = {}) => {
    if (!current || !limiterRoute) {
      return { ok: false, unavailable: true, error: 'No supported FPS limiter is available' };
    }
    const route = normalizeRoute(limiterRoute);
    const underlay = await readUnderlayState(current, route);
    const disableTarget = route.source === 'igcl'
      ? { ...current, limiterEnabled: false }
      : await readDisableTargetState(underlay, route);
    const disableJournal = {
      version: 1,
      route,
      baseline: disableTarget,
      underlay,
      expected: current,
      pending: { from: current, to: disableTarget },
    };
    await saveBaseAndJournal(baseSetting, disableJournal, false, null);
    let disabled;
    try {
      disabled = await applyFrameLimitOnRoute(route, {
        enabled: false,
        value: route.source === 'igcl' ? disableTarget.limit : baseSetting.value,
        expectedState: current,
        automatic,
      });
    } catch (error) {
      return { ok: false, error: errorText(`${route.source.toUpperCase()} could not disable the Graphics FPS Limit`, error) };
    }
    if (disabled?.ok !== true || disabled?.used !== true) {
      if (disabled?.conflict === true || disabled?.errorCode === 'external-change') {
        const observed = await readRawState(route);
        const externalJournal = {
          ...disableJournal,
          expected: observed ?? lastKnownRawState ?? current,
          pending: null,
          externalChange: true,
        };
        await saveBaseAndJournal(baseSetting, externalJournal, false, null);
        status = 'external-change';
      } else {
        status = disabled?.errorCode === 'elevation-required'
          ? 'elevation-required'
          : disabled?.unavailable || disabled?.errorCode === 'unavailable' ? 'recovery-pending' : 'error';
      }
      message = disabled?.error ?? `${route.source.toUpperCase()} did not disable the Graphics FPS Limit`;
      return { ok: false, unavailable: disabled?.unavailable === true || disabled?.errorCode === 'unavailable', error: message };
    }
    const observed = await readRawState(route);
    if (!observed) {
      status = 'recovery-pending';
      message = `${route.source.toUpperCase()} became unavailable while disabling the Graphics FPS Limit; recovery is saved.`;
      return { ok: false, unavailable: true, error: message };
    }
    const appliedState = rawState(disabled.observedState);
    if (appliedState && !sameState(appliedState, observed)) {
      const externalJournal = {
        ...disableJournal,
        baseline: observed,
        expected: observed,
        pending: null,
        externalChange: true,
      };
      await saveBaseAndJournal(baseSetting, externalJournal, false, null);
      status = 'external-change';
      message = `The ${limiterName()} cap changed after disabling the Graphics FPS Limit; the current state was preserved.`;
      return { ok: false, conflict: true, error: message };
    }
    const fieldsMatch = observed.limit === disableTarget.limit && observed.denominator === disableTarget.denominator;
    const flagMatches = observed.limiterEnabled === disableTarget.limiterEnabled
      || (disabled.flagRestorationDeferred === true && observed.limiterEnabled === true);
    if (!fieldsMatch || !flagMatches) {
      const externalJournal = {
        ...disableJournal,
        baseline: observed,
        expected: observed,
        pending: null,
        externalChange: true,
      };
      await saveBaseAndJournal(baseSetting, externalJournal, false, null);
      status = 'external-change';
      message = `The ${limiterName()} cap changed while disabling the Graphics FPS Limit; the current state was preserved.`;
      return { ok: false, conflict: true, error: message };
    }
    const settled = { version: 1, baseline: observed, underlay, expected: observed, pending: null };
    await saveBaseAndJournal(baseSetting, settled, false, null);
    await clearJournal();
    status = hasPolicy() ? 'ready' : 'disabled';
    message = null;
    return { ok: true, observed, restoreToken: disabled.restoreToken ?? null };
  };

  const clearJournal = async () => {
    if (!journal) return;
    await persistArcSleep({ arcSleepJournal: null });
    journal = null;
  };

  const attributedRecoveryState = (actual, candidate) => {
    if (sameState(actual, candidate.baseline) || sameState(actual, candidate.expected)) return true;
    return candidate.pending
      ? transitionStates(candidate.pending.from, candidate.pending.to).some((state) => sameState(actual, state))
      : false;
  };

  const recoverJournal = async () => {
    if (!journal) return true;
    if (journal.externalChange) {
      status = 'external-change';
      message = `The ${limiterName()} frame limit changed outside Arc Power; change the Graphics FPS Limit to re-enable Arc Sleep control.`;
      return false;
    }
    const actual = await readRawState();
    if (!actual) {
      status = 'recovery-pending';
      message = `${limiterName()} is unavailable; Arc Sleep will retry recovery.`;
      return false;
    }
    if (normalizeRoute(journal.route).source === 'igcl') {
      const normalized = {
        ...journal,
        baseline: normalizeStateToCurrentRange(journal.baseline, journal.route),
        underlay: normalizeStateToCurrentRange(journal.underlay, journal.route),
        // Expected/from are observed states used to attribute ownership. Keep
        // those byte-for-byte so range normalization never masks an external
        // writer. Only saved restoration targets may be normalized.
        expected: journal.expected,
        pending: journal.pending ? {
          from: journal.pending.from,
          to: normalizeStateToCurrentRange(journal.pending.to, journal.route),
        } : null,
      };
      const pendingChanged = normalized.pending && !sameState(normalized.pending.to, journal.pending?.to);
      if (!sameState(normalized.baseline, journal.baseline)
        || !sameState(normalized.underlay, journal.underlay)
        || pendingChanged) await saveJournal(normalized);
      await normalizeBaseFrameLimitToCurrentRange();
    }
    if (sameState(actual, journal.baseline)) {
      await clearJournal();
      status = 'ready';
      message = null;
      return true;
    }
    if (!attributedRecoveryState(actual, journal)) {
      status = 'external-change';
      message = `The ${limiterName()} frame limit no longer matches Arc Sleep’s saved transition; the current state was preserved.`;
      return false;
    }

    const recoveryJournal = {
      version: 1,
      baseline: journal.baseline,
      underlay: journal.underlay,
      expected: actual,
      pending: { from: actual, to: journal.baseline },
    };
    await saveJournal(recoveryJournal);
    const restored = await restoreState(actual, journal.baseline);
    if (!restored.ok) {
      status = restored.unavailable ? 'recovery-pending' : (restored.conflict ? 'external-change' : 'error');
      message = restored.error;
      return false;
    }
    await clearJournal();
    status = 'ready';
    message = null;
    return true;
  };

  const initialize = async () => {
    if (initialized) return;
    const saved = await store.loadSettings();
    settings = normalizeArcSleepSettings(saved.arcSleep);
    baseFrameLimit = normalizeBaseFrameLimit(saved.arcSleepFrameLimitBase);
    journal = validJournal(saved.arcSleepJournal);
    invalidJournal = saved.arcSleepJournal != null && !journal;
    pendingBaseDisable = saved.arcSleepPendingBaseDisable === true;
    pendingBaseDisableExpected = pendingBaseDisable ? rawState(saved.arcSleepPendingBaseDisableExpected) : null;
    policyState = createArcSleepPolicyState(settings);
    if (journal) await recoverJournal();
    if (!baseFrameLimit) await ensureBaseFrameLimit(await readRawState());
    initialized = true;
    if (invalidJournal) {
      status = 'recovery-pending';
      message = 'The saved FPS limiter recovery record is invalid; Arc Sleep paused to avoid changing an unverified cap.';
    } else if (status === 'ready') status = hasPolicy() ? 'ready' : 'disabled';
  };

  const effectiveTarget = (policyTarget) => {
    if (policyTarget == null) return baseFrameLimit?.enabled === true ? baseFrameLimit.value : null;
    return baseFrameLimit?.enabled === true
      ? Math.min(baseFrameLimit.value, policyTarget)
      : policyTarget;
  };

  const clampTargetToRange = (value) => {
    if (!Number.isFinite(value)) return null;
    const min = Number.isFinite(frameLimitRange?.min) ? frameLimitRange.min : RTSS_FRAME_LIMIT_MIN;
    const max = Number.isFinite(frameLimitRange?.max) ? frameLimitRange.max : RTSS_FRAME_LIMIT_MAX;
    const step = Number.isFinite(frameLimitRange?.step) && frameLimitRange.step > 0 ? frameLimitRange.step : 1;
    const clamped = Math.max(min, Math.min(max, Math.round(value)));
    return Math.max(min, Math.min(max, min + Math.round((clamped - min) / step) * step));
  };

  const normalizeStateToCurrentRange = (state, route = limiterRoute) => {
    if (!state || normalizeRoute(route).source !== 'igcl') return state;
    const limit = clampTargetToRange(state.limit);
    return limit == null || limit === state.limit ? state : { ...state, limit };
  };

  const normalizeBaseFrameLimitToCurrentRange = async () => {
    if (!baseFrameLimit || limiterRoute?.source !== 'igcl') return;
    const value = clampTargetToRange(baseFrameLimit.value);
    if (value == null || value === baseFrameLimit.value) return;
    baseFrameLimit = { ...baseFrameLimit, value };
    await persistArcSleep({ arcSleepFrameLimitBase: baseFrameLimit });
  };

  const applyDesiredTarget = async (policyTarget, source, { automatic = true } = {}) => {
    let current = await readRawState();
    if (!current) {
      status = journal ? 'recovery-pending' : 'limiter-unavailable';
      message = journal
        ? 'The saved FPS limiter is unavailable; Arc Sleep is holding its recovery journal.'
        : 'RTSS and the selected GPU driver FPS limiter are unavailable.';
      return false;
    }
    if (pendingBaseDisable) {
      if (pendingBaseDisableExpected && !sameState(current, pendingBaseDisableExpected)) {
        const underlay = await readUnderlayState(current);
        const latch = {
          version: 1,
          baseline: current,
          underlay,
          expected: current,
          pending: null,
          externalChange: true,
        };
        await saveBaseAndJournal(baseFrameLimit, latch, false, null);
        status = 'external-change';
        message = `The ${limiterName()} frame limit changed while unavailable; the saved Graphics FPS Limit was preserved.`;
        return false;
      }
      const disabled = await applyBaseDisable(current, baseFrameLimit ?? { enabled: false, value: DEFAULT_BASE_FPS }, { automatic });
      if (!disabled.ok) return false;
      current = await readRawState();
      if (!current) {
        status = 'recovery-pending';
        message = `${limiterName()} became unavailable after applying the pending Graphics FPS Limit change.`;
        return false;
      }
    }
    await ensureBaseFrameLimit(current);
    if (journal?.externalChange) {
      status = 'external-change';
      message = `The ${limiterName()} frame limit changed outside Arc Power; change the Graphics FPS Limit to re-enable Arc Sleep control.`;
      return false;
    }
    if (source !== null && limiterRoute?.source === 'igcl' && frameLimitLiveChange !== true) {
      if (journal) {
        if (!attributedRecoveryState(current, journal)) {
          status = 'external-change';
          message = 'The IGCL frame limit changed outside Arc Power; the current state was preserved.';
          return false;
        }
        const pending = {
          version: 1,
          route: journal.route,
          baseline: journal.baseline,
          underlay: journal.underlay,
          expected: current,
          pending: { from: current, to: journal.baseline },
        };
        await saveJournal(pending);
        const restored = await restoreState(current, journal.baseline, { route: journal.route });
        if (!restored.ok) {
          status = restored.unavailable ? 'recovery-pending' : (restored.conflict ? 'external-change' : 'error');
          message = restored.error;
          return false;
        }
        await clearJournal();
        current = await readRawState(limiterRoute);
        if (!current) {
          status = 'recovery-pending';
          message = 'The IGCL frame limit was restored, but could not be re-read.';
          return false;
        }
      }
      if (baseFrameLimit?.enabled === true) {
        const baseTarget = { limit: baseFrameLimit.value, denominator: 1, limiterEnabled: true };
        if (!sameState(current, baseTarget)) {
          const appliedBase = await writeCap(current, baseFrameLimit.value, { automatic });
          if (!appliedBase.ok) {
            status = appliedBase.elevationRequired ? 'elevation-required' : appliedBase.unavailable ? 'limiter-unavailable' : (appliedBase.conflict ? 'external-change' : 'error');
            message = appliedBase.error;
            return false;
          }
        }
      }
      policySource = null;
      status = 'igcl-static-only';
      message = 'This driver does not report LIVE_CHANGE for the frame limit. The saved Base FPS Cap may affect new games, but Arc Sleep cannot adjust a running game dynamically.';
      return true;
    }

    const targetFps = clampTargetToRange(effectiveTarget(policyTarget));
    if (journal && !sameState(current, journal.expected)) {
      status = 'external-change';
      message = `The ${limiterName()} frame limit changed outside Arc Power; Arc Sleep stopped writing.`;
      return false;
    }

    // No live policy output means release the temporary override to its
    // exact baseline. The baseline can itself be the user's enabled base cap.
    if (source === null && journal) {
      const pending = {
        version: 1,
        baseline: journal.baseline,
        underlay: journal.underlay,
        expected: current,
        pending: { from: current, to: journal.baseline },
      };
      await saveJournal(pending);
      const restored = await restoreState(current, journal.baseline);
      if (!restored.ok) {
        status = restored.unavailable ? 'recovery-pending' : (restored.conflict ? 'external-change' : 'error');
        message = restored.error;
        return false;
      }
      await clearJournal();
      policySource = null;
      status = hasPolicy() ? 'ready' : 'disabled';
      message = null;
      return true;
    }

    if (targetFps == null) {
      if (!journal) {
        status = hasPolicy() ? 'ready' : 'disabled';
        message = null;
        policySource = null;
        return true;
      }
      const pending = {
        version: 1,
        baseline: journal.baseline,
        underlay: journal.underlay,
        expected: current,
        pending: { from: current, to: journal.baseline },
      };
      await saveJournal(pending);
      const restored = await restoreState(current, journal.baseline);
      if (!restored.ok) {
        status = restored.unavailable ? 'recovery-pending' : (restored.conflict ? 'external-change' : 'error');
        message = restored.error;
        return false;
      }
      await clearJournal();
      policySource = null;
      status = hasPolicy() ? 'ready' : 'disabled';
      message = null;
      return true;
    }

    const target = { limit: targetFps, denominator: 1, limiterEnabled: true };
    if (sameState(current, target)) {
      if (source !== null && !journal) {
        const underlay = await readUnderlayState(current);
        const baseline = baseFrameLimit?.enabled === true
          ? { limit: baseFrameLimit.value, denominator: 1, limiterEnabled: true }
          : underlay;
        await saveJournal({ version: 1, baseline, underlay, expected: current, pending: null });
      }
      policySource = source;
      status = source ?? (hasPolicy() ? 'ready' : 'disabled');
      message = null;
      return true;
    }

    const underlay = journal?.underlay ?? await readUnderlayState(current);
    const baseline = journal?.baseline ?? (baseFrameLimit?.enabled === true
      ? { limit: baseFrameLimit.value, denominator: 1, limiterEnabled: true }
      : underlay);
    const temporaryOverride = source !== null;
    if (temporaryOverride) {
      await saveJournal({
        version: 1,
        baseline,
        underlay,
        expected: current,
        pending: { from: current, to: target },
      });
    }
    const baseCapTransition = source === null && !journal;
    if (baseCapTransition) {
      const underlay = await readUnderlayState(current);
      await saveJournal({
        version: 1,
        baseline: target,
        underlay,
        expected: current,
        pending: { from: current, to: target },
      });
    }
    const applied = await writeCap(current, targetFps, {
      automatic: automatic && (source !== null || Boolean(journal) || baseCapTransition),
    });
    if (!applied.ok) {
      if (applied.conflict) {
        const observed = await readRawState();
        const underlay = journal?.underlay ?? await readUnderlayState(observed ?? current);
        const baseline = journal?.baseline
          ?? (baseFrameLimit?.enabled === true
            ? { limit: baseFrameLimit.value, denominator: 1, limiterEnabled: true }
            : underlay);
        await saveJournal({
          version: 1,
          baseline,
          underlay,
          expected: observed ?? lastKnownRawState ?? current,
          pending: null,
          externalChange: true,
        });
        status = 'external-change';
      } else {
        status = applied.elevationRequired ? 'elevation-required' : applied.unavailable ? 'limiter-unavailable' : 'error';
      }
      message = applied.error;
      return false;
    }
    if (temporaryOverride) {
      await saveJournal({ version: 1, baseline, underlay, expected: applied.observed, pending: null });
    } else if (baseCapTransition) {
      await clearJournal();
    }
    policySource = source;
      status = source ?? (hasPolicy() ? 'ready' : 'disabled');
    message = null;
    return true;
  };

  const readPolicySample = async () => {
    let idleSeconds = null;
    try {
      const value = await getIdleSeconds();
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) idleSeconds = value;
    } catch { /* Invalid session input state means active. */ }
    let loadPercent = null;
    let observedFps = null;
    let observedProcessId = null;
    let reportedFps = null;
    let fpsStatus = settings.adaptiveEnabled ? 'gpu-unavailable' : 'disabled';
    if (settings.adaptiveEnabled) {
      try {
        const signals = await getLoadSignals();
        loadPercent = asPercentage(signals?.gpuUtilPct);
      } catch { /* Missing telemetry is handled by the policy grace period. */ }
      const idleActive = settings.idleEnabled && idleSeconds !== null
        && idleSeconds >= settings.idleAfterSeconds;
      if (idleActive) {
        fpsStatus = 'idle-priority';
      } else if (loadPercent !== null && loadPercent <= settings.adaptiveTargetLoadPct) {
        fpsStatus = 'below-trigger';
      } else if (loadPercent !== null) {
        fpsStatus = 'rtss-unavailable';
        try {
          const observation = await getObservedFps();
          const fps = typeof observation?.fps === 'number'
            && Number.isFinite(observation.fps)
            && observation.fps > 0
            && observation.fps <= 1000
            ? observation.fps
            : null;
          reportedFps = fps;
          if (fps !== null && observation?.eligible !== false
            && Number.isSafeInteger(observation?.processId) && observation.processId > 0) {
            observedFps = fps;
            observedProcessId = observation.processId;
            fpsStatus = 'ready';
          } else if (fps !== null && observation?.eligible === false) {
            fpsStatus = 'gpu-unconfirmed';
          }
        } catch { /* Missing FPS falls back to gradual cap reduction. */ }
      }
    }
    const previousFastAdjustmentAtMs = runtimeDiagnostics.lastFastAdjustmentAtMs;
    const result = stepArcSleepPolicy(policyState, settings, {
      idleMs: idleSeconds === null ? null : idleSeconds * 1000,
      loadPercent,
      observedFps,
      observedProcessId,
      nowMs: now(),
    });
    policyState = result.state;
    const sampledAtMs = now();
    runtimeDiagnostics = {
      gpuUtilPct: loadPercent,
      reportedFps,
      fpsStatus,
      lastFastAdjustmentAtMs: result.observedFpsAdjustmentApplied
        ? sampledAtMs
        : previousFastAdjustmentAtMs,
    };
    return result;
  };

  const ensureCurrentRoute = async (deviceKey = null) => {
    let current = await readRawState(null, { preferCurrent: true, deviceKey });
    if (journal && limiterRoute && !sameRoute(journal.route, limiterRoute)) {
      if (!(await recoverJournal())) return null;
      current = await readRawState(null, { preferCurrent: true, deviceKey });
    }
    await normalizeBaseFrameLimitToCurrentRange();
    return current;
  };

  const sampleAndApply = async () => {
    await initialize();
    if (invalidJournal) return;
    if (status === 'elevation-required') return;
    if (journal && (status === 'external-change' || status === 'recovery-pending')) {
      const recovered = await recoverJournal();
      if (!recovered) return;
    }
    const current = await ensureCurrentRoute();
    if (!current) {
      status = journal ? 'recovery-pending' : 'limiter-unavailable';
      message = journal
        ? 'The saved FPS limiter is unavailable; Arc Sleep is holding its recovery journal.'
        : 'RTSS and the selected GPU driver FPS limiter are unavailable.';
      return;
    }
    const result = await readPolicySample();
    await applyDesiredTarget(result.targetFps, result.source);
  };

  const setBaseFrameLimit = async (input, { deviceKey = null } = {}) => {
    let nextBase = normalizeBaseFrameLimit(input);
    if (!nextBase) throw new Error('Arc Sleep base frame limit is invalid');
    if (invalidJournal) {
      status = 'recovery-pending';
      message = 'The saved FPS limiter recovery record is invalid; Arc Sleep paused to avoid changing an unverified cap.';
      return { handled: false, ok: false, error: message };
    }
    const current = await ensureCurrentRoute(deviceKey);
    if (current && limiterRoute?.source === 'igcl') {
      const value = clampTargetToRange(nextBase.value);
      if (value != null) nextBase = { ...nextBase, value };
    }
    const previousBase = baseFrameLimit ? { ...baseFrameLimit } : null;
    const previousJournal = journal ? JSON.parse(JSON.stringify(journal)) : null;
    const previousStatus = status;
    const previousMessage = message;
    const previousPolicySource = policySource;
    const previousPendingBaseDisable = pendingBaseDisable;
    const previousPendingBaseDisableExpected = pendingBaseDisableExpected;
    let nativeRestoreToken = null;
    let rollbackUsed = false;
    const rollback = async () => {
      if (rollbackUsed) return { ok: true };
      rollbackUsed = true;
      if (journal?.externalChange) {
        const observed = await readRawState();
        const externalJournal = {
          ...journal,
          baseline: previousJournal?.baseline ?? current ?? journal.baseline,
          underlay: previousJournal?.underlay ?? journal.underlay,
          expected: observed ?? journal.expected,
          pending: null,
          externalChange: true,
        };
        await saveBaseAndJournal(previousBase, externalJournal, previousPendingBaseDisable, previousPendingBaseDisableExpected);
        status = 'external-change';
        message = `The ${limiterName()} frame limit changed outside Arc Power; the current state was preserved during rollback.`;
        return { ok: false, conflict: true, error: message };
      }
      const expectedBeforeRead = lastKnownRawState;
      const observed = await readRawState();
      if (current && observed && !sameState(current, observed)) {
        const expectedWrite = expectedBeforeRead;
        if (!expectedWrite || !sameState(observed, expectedWrite)) {
          const externalJournal = {
            version: 1,
            baseline: previousJournal?.baseline ?? current,
            underlay: previousJournal?.underlay ?? current,
            expected: observed,
            pending: null,
            externalChange: true,
          };
          await saveBaseAndJournal(previousBase, externalJournal, previousPendingBaseDisable, previousPendingBaseDisableExpected);
          status = 'external-change';
          message = `The ${limiterName()} frame limit changed outside Arc Power during Graphics apply; the current state was preserved.`;
          return { ok: false, conflict: true, error: message };
        }
        const rollbackJournal = {
          version: 1,
          baseline: current,
          underlay: previousJournal?.underlay ?? current,
          expected: observed,
          pending: { from: current, to: observed },
        };
        await saveBaseAndJournal(previousBase, rollbackJournal, previousPendingBaseDisable, previousPendingBaseDisableExpected);
        const retained = previousBase?.enabled === true || Boolean(previousJournal);
        let restored;
        if (nativeRestoreToken && sameState(observed, {
          limit: nativeRestoreToken.expectedLimit,
          denominator: nativeRestoreToken.expectedDenominator,
          limiterEnabled: nativeRestoreToken.expectedEnabled,
        }) && typeof rtssFrameLimiter?.restoreFrameLimit === 'function') {
          const result = await rtssFrameLimiter.restoreFrameLimit(nativeRestoreToken);
          restored = result?.ok === true
            ? { ok: true }
            : { ok: false, conflict: result?.error?.includes('outside Arc Power') === true, error: result?.error ?? 'RTSS rollback was not verified' };
        } else {
          restored = await restoreState(observed, current, { retainOwnership: retained });
        }
        if (!restored.ok) {
          status = restored.unavailable ? 'recovery-pending' : (restored.conflict ? 'external-change' : 'error');
          message = restored.error;
          return restored;
        }
      } else if (current && !observed) {
        const expected = journal?.pending?.to ?? lastKnownRawState ?? current;
        const rollbackJournal = {
          version: 1,
          baseline: current,
          underlay: previousJournal?.underlay ?? current,
          expected,
          pending: { from: current, to: expected },
        };
        await saveBaseAndJournal(previousBase, rollbackJournal, previousPendingBaseDisable, previousPendingBaseDisableExpected);
        status = 'recovery-pending';
        message = `${limiterName()} is unavailable; the previous FPS cap could not be restored.`;
        return { ok: false, unavailable: true, error: message };
      }
      await saveBaseAndJournal(previousBase, previousJournal, previousPendingBaseDisable, previousPendingBaseDisableExpected);
      status = previousStatus;
      message = previousMessage;
      policySource = previousPolicySource;
      return { ok: true };
    };
    if (journal?.externalChange && !current) {
      status = 'limiter-unavailable';
      message = `The saved ${limiterName()} frame limit cannot be checked; recovery must complete before Arc Sleep resumes.`;
      return { handled: false, error: message, rollback };
    }
    if (journal && (journal.externalChange || !current || !sameState(current, journal.expected))) {
      if (current) {
        await clearJournal();
        status = 'ready';
        message = null;
      } else {
        status = journal ? 'recovery-pending' : 'limiter-unavailable';
        message = 'RTSS and the selected GPU driver FPS limiter are unavailable; the saved Graphics FPS Limit was not applied.';
        const deferredJournal = journal ? {
          ...journal,
          externalChange: journal.externalChange === true,
          baseline: nextBase.enabled
            ? { limit: nextBase.value, denominator: 1, limiterEnabled: true }
            : journal.underlay,
        } : null;
        await saveBaseAndJournal(
          nextBase,
          deferredJournal,
          nextBase.enabled !== true,
          nextBase.enabled === true ? null : deferredJournal?.baseline ?? lastKnownRawState,
        );
        return { handled: false, error: message, rollback };
      }
    }
    let nextJournal = journal;
    if (journal) {
      nextJournal = {
        version: 1,
        baseline: nextBase.enabled
          ? { limit: nextBase.value, denominator: 1, limiterEnabled: true }
          : journal.underlay,
        underlay: journal.underlay,
        expected: current ?? journal.expected,
        pending: null,
      };
    }
    const result = await readPolicySample();
    if (!nextBase.enabled && result.targetFps == null && !nextJournal) {
      if (!current) {
        const unavailableMessage = 'RTSS and the selected GPU driver FPS limiter are unavailable; the Graphics FPS Limit was not changed.';
        await saveBaseAndJournal(nextBase, null, true, lastKnownRawState);
        status = 'limiter-unavailable';
        message = unavailableMessage;
        return { handled: false, ok: false, error: unavailableMessage, rollback };
      }
      const disabled = await applyBaseDisable(current, nextBase);
      nativeRestoreToken = disabled.restoreToken ?? null;
      if (!disabled.ok) return { handled: false, ok: false, error: disabled.error, rollback };
      const source = limiterRoute?.source ?? 'rtss';
      return {
          handled: true,
          ok: true,
          source,
          frameLimit: nextBase,
          perControl: { frameLimit: { ok: true, source } },
          rollback,
      };
    }
    await saveBaseAndJournal(nextBase, nextJournal);
    const applied = await applyDesiredTarget(result.targetFps, result.source, { automatic: false });
    return applied
      ? {
          handled: true,
          ok: true,
          source: limiterRoute?.source ?? 'rtss',
          frameLimit: nextBase,
          perControl: { frameLimit: { ok: true, source: limiterRoute?.source ?? 'rtss' } },
          rollback,
        }
      : { handled: false, ok: false, error: message ?? 'Arc Sleep could not apply the base frame limit', rollback };
  };

  const updateSettings = async (nextSettings) => {
    settings = normalizeArcSleepSettings(nextSettings);
    policyState = createArcSleepPolicyState(settings);
    if (journal?.externalChange) {
      status = 'external-change';
      message = `The ${limiterName()} frame limit changed outside Arc Power; change the Graphics FPS Limit to re-enable Arc Sleep control.`;
      return;
    }
    if (!hasPolicy() && journal) {
      const actual = await readRawState();
      if (!actual) {
        status = 'recovery-pending';
        message = `${limiterName()} is unavailable; Arc Sleep will retry recovery.`;
        return;
      }
      if (attributedRecoveryState(actual, journal)) {
        const pending = {
          version: 1,
          baseline: journal.baseline,
          underlay: journal.underlay,
          expected: actual,
          pending: { from: actual, to: journal.baseline },
        };
        await saveJournal(pending);
        const restored = await restoreState(actual, journal.baseline);
        if (restored.ok) await clearJournal();
        else {
          status = restored.unavailable ? 'recovery-pending' : (restored.conflict ? 'external-change' : 'error');
          message = restored.error;
          return;
        }
      } else {
        status = 'external-change';
        message = `The ${limiterName()} frame limit no longer matches Arc Sleep’s saved transition; the current state was preserved.`;
        return;
      }
    }
    await sampleAndApply();
  };

  const getSnapshot = () => ({
    rtssAvailable,
    activeLimiter: limiterRoute?.source ?? null,
    limiterDeviceName,
    limiterDeviceKey: limiterRoute?.source === 'igcl' ? limiterRoute.deviceKey : null,
    liveAdjustmentSupported: limiterRoute?.source === 'rtss' || (limiterRoute?.source === 'igcl' && frameLimitLiveChange),
    frameLimitEffectiveNow: limiterRoute?.source === 'rtss' || (limiterRoute?.source === 'igcl' && frameLimitLiveChange),
    baseCapFps: baseFrameLimit?.enabled === true ? baseFrameLimit.value : null,
    baseFrameLimit: baseFrameLimit ? { ...baseFrameLimit } : null,
    currentFrameLimitFps: lastRawState?.limiterEnabled === true && lastRawState.limit > 0 ? lastRawState.limit : null,
    effectiveCapFps: (limiterRoute?.source !== 'igcl' || frameLimitLiveChange)
      && lastRawState?.limiterEnabled === true && lastRawState.limit > 0 ? lastRawState.limit : null,
    policy: policySource,
    status,
    message,
    diagnostics: {
      gpuUtilPct: runtimeDiagnostics.gpuUtilPct,
      reportedFps: runtimeDiagnostics.reportedFps,
      fpsStatus: runtimeDiagnostics.fpsStatus,
      fastAdjustmentApplied: runtimeDiagnostics.lastFastAdjustmentAtMs !== null
        && now() - runtimeDiagnostics.lastFastAdjustmentAtMs <= 5000,
    },
  });

  const withTransaction = (work) => enqueue(async () => {
    await initialize();
    return work({ setBaseFrameLimit, setSettings: updateSettings, getSnapshot });
  });

  const tick = () => {
    if (tickPending) return tickPending;
    tickPending = enqueue(sampleAndApply).finally(() => { tickPending = null; });
    return tickPending;
  };
  const start = async () => {
    if (stopping) return;
    const startup = enqueue(async () => {
      await initialize();
      await sampleAndApply();
    });
    let timeoutHandle;
    const startupTimedOut = await Promise.race([
      startup.then(() => false),
      new Promise((resolve) => {
        timeoutHandle = setTimeout(() => resolve(true), rtssOperationTimeoutMs);
      }),
    ]).finally(() => clearTimeout(timeoutHandle));
    if (startupTimedOut) {
      // The queued operation is deliberately left in place: its native RTSS
      // call may still be running, so later queue work must not overlap it.
      status = 'error';
      message = 'Arc Sleep is waiting for RTSS to respond. It will continue when the current RTSS operation finishes.';
    }
    if (stopping) return;
    if (timer === null) timer = setIntervalFn(() => {
      void tick().catch((error) => {
        status = 'error';
        message = errorText('Arc Sleep update failed', error);
      });
    }, intervalMs);
  };

  const stop = async () => {
    stopping = true;
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
    const shutdown = enqueue(async () => {
      if (!initialized || !journal) return;
      if (journal.externalChange) {
        status = 'external-change';
        message = `The ${limiterName()} frame limit changed outside Arc Power; the current state was preserved during shutdown.`;
        return;
      }
      const current = await readRawState();
      if (!current || !sameState(current, journal.expected)) {
        status = current ? 'external-change' : 'recovery-pending';
        message = current
          ? `The ${limiterName()} cap changed outside Arc Power; the current state was preserved during shutdown.`
          : `${limiterName()} is unavailable; recovery remains pending.`;
        return;
      }
      const pending = {
        version: 1,
        baseline: journal.baseline,
        underlay: journal.underlay,
        expected: current,
        pending: { from: current, to: journal.baseline },
      };
      await saveJournal(pending);
      const restored = await restoreState(current, journal.baseline);
      if (restored.ok) await clearJournal();
      else {
        status = restored.unavailable ? 'recovery-pending' : (restored.conflict ? 'external-change' : 'error');
        message = restored.error;
      }
    });
    let timeoutHandle;
    const shutdownTimedOut = await Promise.race([
      shutdown.then(() => false),
      new Promise((resolve) => {
        timeoutHandle = setTimeout(() => resolve(true), shutdownTimeoutMs);
      }),
    ]).finally(() => clearTimeout(timeoutHandle));
    if (shutdownTimedOut) {
      // Leave shutdown serialized behind the in-flight RTSS operation. It
      // will finish recovery if that call returns; its durable journal stays
      // available for the next startup if it never does.
      status = 'recovery-pending';
      message = 'Arc Sleep shutdown is waiting for RTSS to respond; recovery remains saved for the next startup.';
    }
  };

  return { start, stop, tick, withTransaction, getSnapshot };
}
