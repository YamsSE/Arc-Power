// Main-owned startup update coordination. This module is Electron-free so
// the single-flight, timeout, status replay, and intent rules stay testable.

export const STARTUP_UPDATE_TIMEOUT_MS = 6000;

export function shouldBlockStartupSplashClose({ updatePending = false, restartResolved = false, handoffStarted = false, fatalSplashFailure = false } = {}) {
  return updatePending === true
    && restartResolved !== true
    && handoffStarted !== true
    && fatalSplashFailure !== true;
}

/**
 * Build a one-shot programmatic splash failure fallback. This is kept
 * Electron-free so the fatal-before-choice and fatal-during-update paths can
 * be exercised with a deterministic fake window.
 */
export function createFatalSplashFallback({ onFailure = null, close = null } = {}) {
  let handled = false;
  return () => {
    if (handled) return false;
    handled = true;
    try { onFailure?.(); } catch { /* failure handling must not block teardown */ }
    try { close?.(); } catch { /* best effort during renderer failure */ }
    return true;
  };
}

function statusForResult(result) {
  if (result?.available && result.version) {
    return {
      state: 'available',
      version: result.version,
      percent: 0,
      message: `Update available: v${result.version}`,
    };
  }
  return {
    state: 'current',
    percent: 100,
    message: 'Arc Power is up to date',
    loadingMessage: 'Loading Arc Power...',
  };
}

/**
 * Own the one startup request shared by the splash and titlebar. A manual
 * request waits for that startup request to settle, then starts a fresh one.
 * @param {{ check: (options: { buildKind: string }) => Promise<object>, timeoutMs?: number }} deps
 */
export function createStartupUpdateCoordinator({ check, timeoutMs = STARTUP_UPDATE_TIMEOUT_MS } = {}) {
  if (typeof check !== 'function') throw new TypeError('startup update check function is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('startup update timeout must be positive');

  let startup = null;
  let manualInFlight = null;
  let latest = { state: 'checking', message: 'Checking for updates...' };
  const listeners = new Set();
  let decisionResolve = null;
  let continueWithoutPrompt = false;
  let updatePending = false;
  let handoffStarted = false;
  let restartResolved = false;
  let fatalSplashFailed = false;

  const publish = (status) => {
    latest = status;
    for (const listener of listeners) {
      try { listener(status); } catch { /* one UI listener cannot break boot */ }
    }
  };

  const run = (buildKind) => {
    publish({ state: 'checking', message: 'Checking for updates...' });
    let timer;
    const request = Promise.race([
      Promise.resolve().then(() => check({ buildKind })),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('GitHub update check timed out')), timeoutMs);
      }),
    ]).then((result) => {
      publish(statusForResult(result));
      return result;
    }).catch((cause) => {
      const timedOut = cause instanceof Error && cause.message.includes('timed out');
      publish({
        state: 'error',
        message: timedOut
          ? 'Update check timed out — continuing startup'
          : 'Update check unavailable — continuing startup',
      });
      throw cause;
    }).finally(() => clearTimeout(timer));
    return request;
  };

  const start = ({ buildKind = 'portable' } = {}) => {
    if (startup) return startup.promise;
    const promise = run(buildKind);
    startup = { buildKind, promise };
    return promise;
  };

  const decision = () => {
    const checkPromise = startup?.promise ?? start();
    return checkPromise.then((result) => {
      if (!result?.available || continueWithoutPrompt) return { action: 'continue', result };
      return new Promise((resolve) => { decisionResolve = resolve; });
    }, () => ({ action: 'continue', result: null }));
  };

  return {
    start,
    decision,
    choose(action) {
      if (action === 'skip') {
        continueWithoutPrompt = true;
        updatePending = false;
        handoffStarted = false;
        decisionResolve?.({ action: 'continue', result: null });
        decisionResolve = null;
        return { ok: true, action: 'continue' };
      }
      if (action === 'update') {
        if (fatalSplashFailed || restartResolved) return { ok: false, action: 'abort' };
        updatePending = true;
        handoffStarted = false;
        return { ok: true, action: 'update' };
      }
      throw new TypeError('startup update choice must be update or skip');
    },
    /** Mark the handoff as successful and resolve startup exactly once. */
    completeUpdate(result = null) {
      if (!updatePending || restartResolved || fatalSplashFailed) return { ok: false, action: 'pending' };
      updatePending = false;
      handoffStarted = false;
      restartResolved = true;
      decisionResolve?.({ action: 'restart', result });
      decisionResolve = null;
      return { ok: true, action: 'restart' };
    },
    /**
     * Resolve a fatal splash failure without allowing a pending replacement
     * to fall through into normal boot. Before Update Now this is a normal
     * continue; after Update Now it is an abort and the caller must quit.
     */
    fatalSplashFailure() {
      if (fatalSplashFailed) return { ok: false, action: updatePending ? 'abort' : 'continue' };
      fatalSplashFailed = true;
      const abortReplacement = updatePending && !restartResolved;
      updatePending = false;
      handoffStarted = false;
      if (abortReplacement) {
        decisionResolve?.({ action: 'abort', reason: 'fatal-splash' });
      } else {
        continueWithoutPrompt = true;
        decisionResolve?.({ action: 'continue', result: null });
      }
      decisionResolve = null;
      return { ok: true, action: abortReplacement ? 'abort' : 'continue' };
    },
    /** Close fallback is suppressed while an update attempt is in progress. */
    continueWithoutPrompt({ force = false } = {}) {
      if (restartResolved || (updatePending && !force)) return;
      continueWithoutPrompt = true;
      updatePending = false;
      handoffStarted = false;
      decisionResolve?.({ action: 'continue', result: null });
      decisionResolve = null;
    },
    /** Allow the splash to close after a detached replacement has started.
     * This deliberately does not resolve the startup decision: the detached
     * installer owns post-exit copy/launch diagnostics, so spawn is not a
     * restart-success confirmation. */
    markHandoffStarted() {
      if (updatePending && !restartResolved && !fatalSplashFailed) handoffStarted = true;
      return { ok: handoffStarted, action: handoffStarted ? 'restart-pending' : 'pending' };
    },
    setStatus(status) { publish(status); },
    check({ buildKind = 'portable', intent = 'startup' } = {}) {
      if (intent === 'startup') return startup?.promise ?? start({ buildKind });
      if (intent !== 'manual') throw new TypeError('update check intent must be startup or manual');
      if (manualInFlight) return manualInFlight;
      const afterStartup = startup?.promise
        ? startup.promise.then(() => undefined, () => undefined)
        : Promise.resolve();
      const request = afterStartup.then(() => run(buildKind));
      const tracked = request.finally(() => {
        if (manualInFlight === tracked) manualInFlight = null;
      });
      manualInFlight = tracked;
      return tracked;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('startup update listener must be a function');
      listeners.add(listener);
      try { listener(latest); } catch { /* replay is best effort */ }
      return () => listeners.delete(listener);
    },
    latest: () => latest,
    startupPromise: () => startup?.promise ?? null,
    startupResult: async () => startup?.promise ?? start(),
    manualInFlight: () => manualInFlight,
    updatePending: () => updatePending,
    handoffStarted: () => handoffStarted,
    restartResolved: () => restartResolved,
    fatalSplashFailed: () => fatalSplashFailed,
  };
}
