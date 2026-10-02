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

function validJournal(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) return null;
  const baseline = rawState(value.baseline);
  const underlay = rawState(value.underlay) ?? baseline;
  const expected = rawState(value.expected);
  if (!baseline || !underlay || !expected) return null;
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
 * Owns Arc Sleep's global RTSS cap and serializes it with Graphics apply.
 * withTransaction must wrap the full graphics transaction, including its
 * driver apply and rollback.
 */
export function createArcSleepController({
  store,
  rtssFrameLimiter,
  getIdleSeconds = () => null,
  getLoadSignals = async () => null,
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
  let pendingBaseDisable = false;
  let pendingBaseDisableExpected = null;
  let policyState = createArcSleepPolicyState(settings);
  let policySource = null;
  let status = 'ready';
  let message = null;
  let rtssAvailable = false;
  let lastRawState = null;
  let lastKnownRawState = null;
  let timer = null;
  let tickPending = null;
  let initialized = false;
  let stopping = false;

  const hasPolicy = () => settings.idleEnabled || settings.adaptiveEnabled;
  const errorText = (fallback, error) => error instanceof Error ? error.message : (error ? String(error) : fallback);

  const persistArcSleep = async (patch) => {
    if (typeof store?.saveArcSleepState === 'function') {
      await store.saveArcSleepState(patch);
      return;
    }
    const current = await store.loadSettings();
    await store.saveSettings({ ...current, ...patch });
  };

  const readRawState = async () => {
    if (typeof rtssFrameLimiter?.getFrameLimit !== 'function') {
      rtssAvailable = false;
      lastRawState = null;
      return null;
    }
    try {
      const result = await rtssFrameLimiter.getFrameLimit();
      const state = result?.ok === true
        ? rawState({ limit: result.limit, denominator: result.denominator ?? 1, limiterEnabled: result.limiterEnabled })
        : null;
      rtssAvailable = state !== null;
      lastRawState = state;
      if (state) lastKnownRawState = state;
      return state;
    } catch {
      rtssAvailable = false;
      lastRawState = null;
      return null;
    }
  };

  const readUnderlayState = async (fallback) => {
    if (typeof rtssFrameLimiter?.getFrameLimitOwnership !== 'function') return fallback;
    try {
      const result = await rtssFrameLimiter.getFrameLimitOwnership();
      return result?.ok === true ? rawState(result.underlay) ?? fallback : fallback;
    } catch {
      return fallback;
    }
  };

  const readDisableTargetState = async (fallback) => {
    if (typeof rtssFrameLimiter?.getFrameLimitOwnership !== 'function') return fallback;
    try {
      const result = await rtssFrameLimiter.getFrameLimitOwnership();
      return result?.ok === true ? rawState(result.disableState) ?? fallback : fallback;
    } catch {
      return fallback;
    }
  };

  const writeCap = async (expectedState, targetFps) => {
    if (typeof rtssFrameLimiter?.applyFrameLimit !== 'function') {
      return { ok: false, unavailable: true, error: 'RTSS frame limiter is unavailable' };
    }
    let result;
    try {
      result = await rtssFrameLimiter.applyFrameLimit({ enabled: true, value: targetFps, expectedState });
    } catch (error) {
      return { ok: false, error: errorText('RTSS cap apply failed', error) };
    }
    if (result?.conflict === true || result?.errorCode === 'external-change') {
      return { ok: false, conflict: true, error: result.error ?? 'RTSS global frame-limit state changed outside Arc Power' };
    }
    if (result?.ok !== true || result?.used !== true) {
      return {
        ok: false,
        unavailable: result?.available === false || result?.errorCode === 'unavailable',
        error: result?.error ?? 'RTSS did not apply the Arc Sleep cap',
      };
    }
    const observed = await readRawState();
    if (!observed || observed.limit !== targetFps || observed.denominator !== 1 || observed.limiterEnabled !== true) {
      return { ok: false, error: 'RTSS cap read-back did not match Arc Sleep target', observed };
    }
    return { ok: true, observed };
  };

  const restoreState = async (expectedState, targetState, { retainOwnership = baseFrameLimit?.enabled === true } = {}) => {
    if (typeof rtssFrameLimiter?.restoreFrameLimitState !== 'function') {
      return { ok: false, unavailable: true, error: 'RTSS recovery support is unavailable' };
    }
    try {
      const result = await rtssFrameLimiter.restoreFrameLimitState({
        expectedState,
        state: targetState,
        retainOwnership,
      });
      if (result?.conflict === true || result?.errorCode === 'external-change') {
        return { ok: false, conflict: true, error: result.error ?? 'RTSS global frame-limit state changed outside Arc Power' };
      }
      if (result?.ok !== true) {
        return { ok: false, unavailable: result?.errorCode === 'unavailable', error: result?.error ?? 'RTSS state restoration failed' };
      }
      const observed = rawState(result.observedState) ?? await readRawState();
      const fieldsMatch = observed?.limit === targetState.limit && observed?.denominator === targetState.denominator;
      const flagMatches = observed?.limiterEnabled === targetState.limiterEnabled
        || (result.flagRestorationDeferred === true && observed?.limiterEnabled === true);
      if (!fieldsMatch || !flagMatches) return { ok: false, error: 'RTSS recovery read-back did not match the saved baseline', observed };
      rtssAvailable = true;
      lastRawState = observed;
      lastKnownRawState = observed;
      return { ok: true, observed, flagRestorationDeferred: result.flagRestorationDeferred === true };
    } catch (error) {
      return { ok: false, error: errorText('RTSS state restoration failed', error) };
    }
  };

  const saveJournal = async (nextJournal) => {
    const clean = validJournal(nextJournal);
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
    const cleanJournal = nextJournal == null ? null : validJournal(nextJournal);
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

  const applyBaseDisable = async (current, baseSetting) => {
    if (typeof rtssFrameLimiter?.applyFrameLimit !== 'function' || !current) {
      return { ok: false, unavailable: true, error: 'RTSS is unavailable' };
    }
    const underlay = await readUnderlayState(current);
    const disableTarget = await readDisableTargetState(underlay);
    const disableJournal = {
      version: 1,
      baseline: disableTarget,
      underlay,
      expected: current,
      pending: { from: current, to: disableTarget },
    };
    await saveBaseAndJournal(baseSetting, disableJournal, false, null);
    let disabled;
    try {
      disabled = await rtssFrameLimiter.applyFrameLimit({
        enabled: false,
        value: baseSetting.value,
        expectedState: current,
      });
    } catch (error) {
      return { ok: false, error: errorText('RTSS could not disable the Graphics FPS Limit', error) };
    }
    if (disabled?.ok !== true || disabled?.used !== true) {
      if (disabled?.conflict === true || disabled?.errorCode === 'external-change') {
        const observed = await readRawState();
        const externalJournal = {
          ...disableJournal,
          expected: observed ?? lastKnownRawState ?? current,
          pending: null,
          externalChange: true,
        };
        await saveBaseAndJournal(baseSetting, externalJournal, false, null);
        status = 'external-change';
      } else {
        status = disabled?.unavailable || disabled?.errorCode === 'unavailable' ? 'recovery-pending' : 'error';
      }
      message = disabled?.error ?? 'RTSS did not disable the Graphics FPS Limit';
      return { ok: false, unavailable: disabled?.unavailable === true || disabled?.errorCode === 'unavailable', error: message };
    }
    const observed = await readRawState();
    if (!observed) {
      status = 'recovery-pending';
      message = 'RTSS became unavailable while disabling the Graphics FPS Limit; recovery is saved.';
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
      message = 'The RTSS cap changed after disabling the Graphics FPS Limit; the current state was preserved.';
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
      message = 'The RTSS cap changed while disabling the Graphics FPS Limit; the current state was preserved.';
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
      message = 'The RTSS global cap changed outside Arc Power; change the Graphics FPS Limit to re-enable Arc Sleep control.';
      return false;
    }
    const actual = await readRawState();
    if (!actual) {
      status = 'recovery-pending';
      message = 'RTSS is unavailable; Arc Sleep will retry recovery.';
      return false;
    }
    if (sameState(actual, journal.baseline)) {
      await clearJournal();
      status = 'ready';
      message = null;
      return true;
    }
    if (!attributedRecoveryState(actual, journal)) {
      status = 'external-change';
      message = 'The RTSS global cap no longer matches Arc Sleep’s saved transition; the current RTSS state was preserved.';
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
    pendingBaseDisable = saved.arcSleepPendingBaseDisable === true;
    pendingBaseDisableExpected = pendingBaseDisable ? rawState(saved.arcSleepPendingBaseDisableExpected) : null;
    policyState = createArcSleepPolicyState(settings);
    if (journal) await recoverJournal();
    if (!baseFrameLimit) await ensureBaseFrameLimit(await readRawState());
    initialized = true;
    if (status === 'ready') status = hasPolicy() ? 'ready' : 'disabled';
  };

  const effectiveTarget = (policyTarget) => {
    if (policyTarget == null) return baseFrameLimit?.enabled === true ? baseFrameLimit.value : null;
    return baseFrameLimit?.enabled === true
      ? Math.min(baseFrameLimit.value, policyTarget)
      : policyTarget;
  };

  const applyDesiredTarget = async (policyTarget, source) => {
    let current = await readRawState();
    if (!current) {
      status = journal ? 'recovery-pending' : 'rtss-unavailable';
      message = journal
        ? 'RTSS is unavailable; Arc Sleep is holding its recovery journal.'
        : 'RTSS is unavailable; Arc Sleep cannot apply a frame cap.';
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
        message = 'The RTSS global cap changed while unavailable; the saved Graphics FPS Limit was preserved.';
        return false;
      }
      const disabled = await applyBaseDisable(current, baseFrameLimit ?? { enabled: false, value: DEFAULT_BASE_FPS });
      if (!disabled.ok) return false;
      current = await readRawState();
      if (!current) {
        status = 'recovery-pending';
        message = 'RTSS became unavailable after applying the pending Graphics FPS Limit change.';
        return false;
      }
    }
    await ensureBaseFrameLimit(current);
    if (journal?.externalChange) {
      status = 'external-change';
      message = 'The RTSS global cap changed outside Arc Power; change the Graphics FPS Limit to re-enable Arc Sleep control.';
      return false;
    }
    const targetFps = effectiveTarget(policyTarget);
    if (journal && !sameState(current, journal.expected)) {
      status = 'external-change';
      message = 'The RTSS global cap changed outside Arc Power; Arc Sleep stopped writing.';
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
    const applied = await writeCap(current, targetFps);
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
        status = applied.unavailable ? 'rtss-unavailable' : 'error';
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
    if (settings.adaptiveEnabled) {
      try {
        const signals = await getLoadSignals();
        loadPercent = asPercentage(signals?.gpuUtilPct);
      } catch { /* Missing telemetry is handled by the policy grace period. */ }
    }
    const result = stepArcSleepPolicy(policyState, settings, {
      idleMs: idleSeconds === null ? null : idleSeconds * 1000,
      loadPercent,
      nowMs: now(),
    });
    policyState = result.state;
    return result;
  };

  const sampleAndApply = async () => {
    await initialize();
    if (journal && (status === 'external-change' || status === 'recovery-pending')) {
      const recovered = await recoverJournal();
      if (!recovered) return;
    }
    const result = await readPolicySample();
    await applyDesiredTarget(result.targetFps, result.source);
  };

  const setBaseFrameLimit = async (input) => {
    const nextBase = normalizeBaseFrameLimit(input);
    if (!nextBase) throw new Error('Arc Sleep base frame limit is invalid');
    const current = await readRawState();
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
        message = 'The RTSS global cap changed outside Arc Power; the current RTSS state was preserved during rollback.';
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
          message = 'The RTSS global cap changed outside Arc Power during Graphics apply; the current RTSS state was preserved.';
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
        message = 'RTSS is unavailable; the previous FPS cap could not be restored.';
        return { ok: false, unavailable: true, error: message };
      }
      await saveBaseAndJournal(previousBase, previousJournal, previousPendingBaseDisable, previousPendingBaseDisableExpected);
      status = previousStatus;
      message = previousMessage;
      policySource = previousPolicySource;
      return { ok: true };
    };
    if (journal?.externalChange && !current) {
      status = 'rtss-unavailable';
      message = 'RTSS is unavailable; change the Graphics FPS Limit when RTSS is available to re-enable Arc Sleep control.';
      return { handled: false, error: message, rollback };
    }
    if (journal && (journal.externalChange || !current || !sameState(current, journal.expected))) {
      if (current) {
        await clearJournal();
        status = 'ready';
        message = null;
      } else {
        status = journal ? 'recovery-pending' : 'rtss-unavailable';
        message = 'RTSS is unavailable; the saved Graphics FPS Limit will apply when RTSS returns.';
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
        const unavailableMessage = 'RTSS is unavailable; the Graphics FPS Limit will be disabled when RTSS returns.';
        await saveBaseAndJournal(nextBase, null, true, lastKnownRawState);
        status = 'rtss-unavailable';
        message = unavailableMessage;
        return { handled: false, ok: false, error: unavailableMessage, rollback };
      }
      const disabled = await applyBaseDisable(current, nextBase);
      nativeRestoreToken = disabled.restoreToken ?? null;
      if (!disabled.ok) return { handled: false, ok: false, error: disabled.error, rollback };
      return {
        handled: true,
        ok: true,
        source: 'rtss',
        frameLimit: nextBase,
        perControl: { frameLimit: { ok: true, source: 'rtss' } },
        rollback,
      };
    }
    await saveBaseAndJournal(nextBase, nextJournal);
    const applied = await applyDesiredTarget(result.targetFps, result.source);
    return applied
      ? {
          handled: true,
          ok: true,
          source: 'rtss',
          frameLimit: nextBase,
          perControl: { frameLimit: { ok: true, source: 'rtss' } },
          rollback,
        }
      : { handled: false, ok: false, error: message ?? 'Arc Sleep could not apply the base frame limit', rollback };
  };

  const updateSettings = async (nextSettings) => {
    settings = normalizeArcSleepSettings(nextSettings);
    policyState = createArcSleepPolicyState(settings);
    if (journal?.externalChange) {
      status = 'external-change';
      message = 'The RTSS global cap changed outside Arc Power; change the Graphics FPS Limit to re-enable Arc Sleep control.';
      return;
    }
    if (!hasPolicy() && journal) {
      const actual = await readRawState();
      if (!actual) {
        status = 'recovery-pending';
        message = 'RTSS is unavailable; Arc Sleep will retry recovery.';
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
        message = 'The RTSS global cap no longer matches Arc Sleep’s saved transition; the current RTSS state was preserved.';
        return;
      }
    }
    await sampleAndApply();
  };

  const getSnapshot = () => ({
    rtssAvailable,
    baseCapFps: baseFrameLimit?.enabled === true ? baseFrameLimit.value : null,
    baseFrameLimit: baseFrameLimit ? { ...baseFrameLimit } : null,
    effectiveCapFps: rtssAvailable && lastRawState?.limiterEnabled === true && lastRawState.limit > 0 ? lastRawState.limit : null,
    policy: policySource,
    status,
    message,
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
        message = 'The RTSS global cap changed outside Arc Power; the current state was preserved during shutdown.';
        return;
      }
      const current = await readRawState();
      if (!current || !sameState(current, journal.expected)) {
        status = current ? 'external-change' : 'recovery-pending';
        message = current
          ? 'The RTSS cap changed outside Arc Power; the current state was preserved during shutdown.'
          : 'RTSS is unavailable; recovery remains pending.';
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
