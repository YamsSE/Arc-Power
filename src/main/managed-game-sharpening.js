import { canonicalExePath } from './game-candidate.js';

const LAUNCH_REASON = 'Launch the game from its Arc Power profile to use Arc Image Sharpening.';
function identityKey(target) {
  if (!target || !Number.isInteger(target.pid) || target.pid < 1 || typeof target.creationFiletime !== 'string'
    || !/^[1-9][0-9]*$/.test(target.creationFiletime) || !canonicalExePath(target.exePath)) return null;
  return `${target.pid}:${target.creationFiletime}`;
}

/** Owns in-game shader control only. ASR has a separate helper and lifecycle. */
export function createManagedGameSharpening({ control, launcher, detector, isGameExecutable, effectiveFor,
  isEnabled, onChange = () => {}, pollMs = 1000, now = Date.now } = {}) {
  if (!control || !launcher || typeof detector?.detectProcessIdentity !== 'function'
    || [isGameExecutable, effectiveFor, isEnabled].some((fn) => typeof fn !== 'function')) throw new TypeError('Managed sharpening dependencies are required');
  const ready = launcher.ready();
  const targets = new Map();
  const misses = new Set();
  let started = false, stopped = false, timer = null, syncing = null, dirty = false;
  let foregroundKey = null, reason = ready ? null : 'The bundled game-sharpening runtime failed its integrity check.';
  const state = () => {
    const current = targets.get(foregroundKey);
    const desired = current && effectiveFor(current.exePath);
    return { runtimeReady: ready, active: Boolean(desired?.enabled && desired.percentage > 0 && current?.applied === current?.signature && current?.signature),
      requiresRestart: !current?.ready, provider: 'managed', launchSupported: ready,
      reason: reason ?? (isEnabled() && !current ? LAUNCH_REASON : null) };
  };
  const notify = () => { try { onChange(state()); } catch { /* A UI listener cannot break shader control. */ } };
  const rememberMiss = (key) => { misses.add(key); if (misses.size > 128) misses.delete(misses.values().next().value); };
  const update = async (target) => {
    const queryArgs = { pid: target.pid, creationFiletime: target.creationFiletime };
    let response;
    try {
      response = await control.query(queryArgs);
      target.ready = true;
    } catch (error) {
      if (!target.ready && now() < target.startupDeadline) return;
      targets.delete(identityKey(target)); rememberMiss(identityKey(target));
      if (foregroundKey === identityKey(target)) reason = LAUNCH_REASON;
      return;
    }
    const effective = effectiveFor(target.exePath);
    const enabled = effective.enabled === true && effective.percentage > 0;
    const percentage = enabled ? effective.percentage : 0;
    const signature = `${enabled ? 1 : 0}:${percentage}`;
    if (target.signature !== signature) {
      if (response.acceptedRevision >= 0xffff_ffff) throw new Error('Restart the game to reset its sharpening control revision.');
      const revision = response.acceptedRevision + 1;
      const accepted = await control.set({ ...queryArgs, revision, enabled, percentage });
      if (accepted.status !== 0 || accepted.acceptedRevision !== revision) throw new Error('The game did not accept the sharpening setting.');
      target.signature = signature; target.revision = revision; target.applied = null;
      target.applyDeadline = now() + 5000;
      response = accepted;
    }
    if (response.appliedRevision === target.revision) target.applied = target.signature;
    if (foregroundKey === identityKey(target)) reason = target.applied === target.signature ? null : 'Sharpening is saved; waiting for the game to render the updated setting.';
  };
  const schedule = () => {
    if (!started || stopped || timer || (!isEnabled() && ![...targets.values()].some((t) => !t.ready || (t.applied !== t.signature && now() < t.applyDeadline)))) return;
    timer = setTimeout(() => { timer = null; void synchronize(); }, pollMs);
    timer.unref?.();
  };
  const synchronize = () => {
    dirty = true;
    if (syncing) return syncing;
    syncing = (async () => {
      while (dirty && !stopped) {
        dirty = false;
        try {
          const foreground = await detector.detectProcessIdentity();
          const key = identityKey(foreground);
          foregroundKey = key;
          if (isEnabled() && key && !targets.has(key) && !misses.has(key) && await isGameExecutable(foreground.exePath)) {
            if (targets.size < 32) targets.set(key, { ...foreground, ready: false, startupDeadline: 0, signature: null, applied: null });
          }
          for (const target of [...targets.values()]) {
            if (stopped) break;
            await update(target);
          }
        } catch (error) { reason = `Arc Image Sharpening could not update the game: ${error.message}`; }
        notify();
      }
    })().finally(() => { syncing = null; schedule(); });
    return syncing;
  };
  return {
    state,
    start() { started = true; stopped = false; if (ready) void synchronize(); return state(); },
    async settingsChanged() { if (ready && started && !stopped) await synchronize(); return state(); },
    async launchGame(exePath) {
      if (!ready || stopped) throw new Error('Arc Image Sharpening is unavailable');
      const target = await launcher.launch(exePath); const key = identityKey(target);
      if (!key) throw new Error('The managed game did not return a valid process identity');
      if (targets.size >= 32) throw new Error('Too many managed game sessions are active');
      misses.delete(key); targets.set(key, { ...target, ready: false, startupDeadline: now() + 30000, signature: null, applied: null });
      if (started) void synchronize();
      return { ...target, sharpeningPending: true };
    },
    async stop() {
      stopped = true; started = false; dirty = false;
      if (timer) clearTimeout(timer); timer = null;
      // Send Off to every attached game; a paused game applies this on its
      // next rendered frame. Its process and loaded DLL remain alive.
      const reset = (async () => {
        try { await syncing; } catch { /* Continue to best-effort reset. */ }
        for (const target of targets.values()) {
          if (!target.ready) continue;
          try {
            const query = await control.query({ pid: target.pid, creationFiletime: target.creationFiletime });
            if (query.acceptedRevision < 0xffff_ffff) await control.set({ pid: target.pid, creationFiletime: target.creationFiletime,
              revision: query.acceptedRevision + 1, enabled: false, percentage: 0 });
          } catch { /* The game may have exited. */ }
        }
      })();
      let deadline;
      try { await Promise.race([reset, new Promise((resolve) => { deadline = setTimeout(resolve, 2500); })]); }
      finally { clearTimeout(deadline); }
      await control.stop(); targets.clear(); misses.clear(); foregroundKey = null; notify();
    },
  };
}
