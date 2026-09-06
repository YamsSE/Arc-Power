// M188c Stability Lab lifecycle. Hardware and clock dependencies are injected
// so the run can be tested without Electron, timers, or native telemetry.
import crypto from 'node:crypto';
import { classifyStabilityRun, normalizeStabilityReport, normalizeStabilityRequest, normalizeStabilitySample, workloadEvidenceOf } from './stability-pure.js';

function stableKeyOf(target) {
  return typeof target?.deviceKey === 'string' ? target.deviceKey.trim() : null;
}

export function createStabilityLabService({
  resolveTarget = async () => null,
  sampleTarget = async () => null,
  workloadProbe = async () => null,
  settingsSnapshot = async () => ({}),
  reportStore = null,
  clock = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  onStatus = () => {},
} = {}) {
  let active = null;

  const publish = (run) => {
    const status = statusOf(run);
    try { onStatus(status); } catch { /* status listeners are best effort */ }
    return status;
  };
  const statusOf = (run) => run ? {
    runId: run.runId,
    state: run.state,
    target: run.target ? { ...run.target } : null,
    effectiveCadenceMs: run.cadenceMs,
    effectiveDurationSec: run.durationSec,
    sampleCount: run.sampleCount,
    freshSampleCount: run.freshSampleCount,
    missingMetrics: [...run.missingMetrics],
    workloadEvidence: workloadEvidenceOf(run),
    foregroundCount: run.foregroundCount,
    presentEvidenceCount: run.presentEvidenceCount,
    utilEvidenceCount: run.utilEvidenceCount,
    outcome: run.outcome ?? null,
    reason: run.reason ?? null,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
  } : null;

  const finish = async (run, outcome, reason = null) => {
    if (!run || run.finished) return run?.report ?? null;
    run.finished = true;
    if (run.timer !== null) { clearTimer(run.timer); run.timer = null; }
    run.state = 'completed';
    run.outcome = outcome;
    run.reason = reason;
    run.endedAt = new Date(clock()).toISOString();
    const verdict = classifyStabilityRun({
      ...run,
      outcomeHint: outcome,
      cancelled: outcome === 'cancelled',
      unavailable: outcome === 'unavailable',
    });
    const report = normalizeStabilityReport({
      runId: run.runId,
      target: run.target,
      settingsSnapshot: run.settingsSnapshot,
      sampleCount: run.sampleCount,
      freshSampleCount: run.freshSampleCount,
      missingMetrics: [...run.missingMetrics],
      workloadEvidence: verdict.workloadEvidence,
      outcome: verdict.outcome,
      effectiveCadenceMs: run.cadenceMs,
      effectiveDurationSec: run.durationSec,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      reason,
      thresholdBreaches: run.thresholdBreaches,
      driverErrorCount: run.driverErrorCount,
    });
    run.report = report;
    try { await reportStore?.append?.(report); } catch (error) { run.reason = `${reason ? `${reason}; ` : ''}report persistence failed: ${error.message}`; }
    publish(run);
    if (active === run) active = null;
    return report;
  };

  const tick = async (run) => {
    if (!run || run.finished || active !== run) return;
    if (clock() - run.startedMs >= run.durationSec * 1000) { await finish(run, 'completed'); return; }
    let liveTarget = null;
    try { liveTarget = await resolveTarget(run.target?.deviceKey); } catch { liveTarget = null; }
    if (!liveTarget || stableKeyOf(liveTarget) !== run.target?.deviceKey) {
      await finish(run, 'unavailable', 'selected device changed or is no longer available');
      return;
    }
    let data;
    try {
      data = await sampleTarget(run.target);
      if (!data) data = {};
    } catch (error) { data = { readError: error.message }; }
    if (active !== run || run.finished) return;
    const probe = data.foregroundProcess === undefined ? await workloadProbe(run.target).catch(() => null) : data.foregroundProcess;
    // Freshness is measured at the main-process receipt boundary. Driver
    // counters may be seconds since boot or another relative clock; retain
    // that source timestamp without comparing it to Date.now().
    const normalized = normalizeStabilitySample({ ...data, receivedAtMs: data.receivedAtMs ?? data.sampledAtMs, foregroundProcess: probe ?? data.foregroundProcess }, clock());
    run.sampleCount += 1;
    const age = Math.max(0, clock() - normalized.sampledAtMs);
    const fresh = !normalized.readError && age <= Math.max(1000, run.cadenceMs * 2.5);
    if (fresh) run.freshSampleCount += 1;
    if (normalized.foreground) run.foregroundCount += 1;
    if (normalized.present) run.presentEvidenceCount += 1;
    if (normalized.utilPct !== null && normalized.utilPct >= 10) run.utilEvidenceCount += 1;
    if (normalized.readError) run.missingMetrics.add('telemetry');
    if (normalized.temperatureC === null) run.missingMetrics.add('temperature');
    if (normalized.powerW === null) run.missingMetrics.add('power');
    if (normalized.driverError) run.driverErrorCount += 1;
    const thermalLimit = Number(run.settingsSnapshot?.stabilityTemperatureLimitC ?? run.settingsSnapshot?.tempLimitC);
    const powerLimit = Number(run.settingsSnapshot?.stabilityPowerLimitW ?? run.settingsSnapshot?.powerLimitW);
    if (Number.isFinite(thermalLimit) && normalized.temperatureC !== null && normalized.temperatureC > thermalLimit) run.thresholdBreaches += 1;
    if (Number.isFinite(powerLimit) && normalized.powerW !== null && normalized.powerW > powerLimit) run.thresholdBreaches += 1;
    publish(run);
    if (clock() - run.startedMs >= run.durationSec * 1000) await finish(run, 'completed');
    else run.timer = setTimer(() => { void tick(run); }, run.cadenceMs);
  };

  return {
    async start(payload) {
      if (active && !active.finished) throw new Error('A Stability Lab run is already active');
      const request = normalizeStabilityRequest(payload);
      const target = await resolveTarget(request.deviceKey);
      const resolvedKey = stableKeyOf(target);
      const run = {
        runId: crypto.randomUUID(), state: 'running', target: target ? { id: Number.isInteger(target.id) ? target.id : null, deviceKey: resolvedKey ?? request.deviceKey, name: target.name ?? null } : { id: null, deviceKey: request.deviceKey, name: null },
        cadenceMs: request.cadenceMs, durationSec: request.durationSec, startedMs: clock(), startedAt: new Date(clock()).toISOString(), endedAt: null,
        settingsSnapshot: {}, sampleCount: 0, freshSampleCount: 0, foregroundCount: 0, presentEvidenceCount: 0, utilEvidenceCount: 0,
        missingMetrics: new Set(), thresholdBreaches: 0, driverErrorCount: 0, timer: null, finished: false, outcome: null, reason: null, report: null,
      };
      active = run;
      if (!target || (resolvedKey && resolvedKey !== request.deviceKey)) return finish(run, 'unavailable', 'selected device is unavailable or changed');
      try { run.settingsSnapshot = { ...(await settingsSnapshot(target) ?? {}) }; } catch { run.settingsSnapshot = {}; }
      publish(run);
      run.timer = setTimer(() => { void tick(run); }, 0);
      return statusOf(run);
    },
    async cancel(runId) {
      if (!active || (runId && active.runId !== runId)) return active ? statusOf(active) : null;
      const run = active;
      const report = await finish(run, 'cancelled', 'cancelled by user');
      return report;
    },
    status(runId) { return !active || (runId && active.runId !== runId) ? null : statusOf(active); },
    active() { return statusOf(active); },
    async stop() { if (active) await finish(active, 'cancelled', 'application shutdown'); },
  };
}
