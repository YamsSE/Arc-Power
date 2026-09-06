// M188c - pure bounds, sample normalization, and Stability Lab classification.

export const STABILITY_SCHEMA_VERSION = 1;
export const STABILITY_CADENCE_MIN_MS = 250;
export const STABILITY_CADENCE_MAX_MS = 2000;
export const STABILITY_DURATION_MIN_SEC = 10;
export const STABILITY_DURATION_MAX_SEC = 900;
export const STABILITY_MAX_REPORTS = 50;

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }

export function normalizeStableDeviceKey(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return key.length >= 2 && key.length <= 512 ? key : null;
}

export function clampCadenceMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(STABILITY_CADENCE_MAX_MS, Math.max(STABILITY_CADENCE_MIN_MS, Math.round(numeric)));
}

export function clampDurationSec(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(STABILITY_DURATION_MAX_SEC, Math.max(STABILITY_DURATION_MIN_SEC, Math.round(numeric)));
}

export function normalizeStabilityRequest(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('stability request must be an object');
  const deviceKey = normalizeStableDeviceKey(payload.deviceKey);
  if (!deviceKey) throw new Error('stability request requires a stable device key');
  const cadenceMs = clampCadenceMs(payload.cadenceMs);
  const durationSec = clampDurationSec(payload.durationSec);
  if (cadenceMs === null || durationSec === null) throw new Error('stability cadence or duration is invalid');
  return { deviceKey, cadenceMs, durationSec };
}

export function normalizeTimestampMs(value, fallbackMs = Date.now()) {
  if (!finite(value)) return finite(fallbackMs) ? fallbackMs : Date.now();
  // Mock/native backends use seconds while renderer/IPC samples commonly use
  // epoch milliseconds. Convert only values that cannot plausibly be epoch ms.
  return value > 0 && value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}

/** Receipt clocks are local values. Small injected clocks must not be treated
 * as driver seconds; source timestamps use normalizeTimestampMs below. */
export function normalizeReceiptTimestampMs(value, fallbackMs = Date.now()) {
  return finite(value) ? Math.round(value) : (finite(fallbackMs) ? Math.round(fallbackMs) : Date.now());
}

export function normalizeStabilitySample(input, nowMs = Date.now()) {
  const raw = input && typeof input === 'object' ? input : {};
  const sample = raw.sample && typeof raw.sample === 'object' ? raw.sample : raw;
  const sourceTimestampMs = normalizeTimestampMs(sample.tMs ?? sample.t ?? sample.timestamp, nowMs);
  const receivedAtMs = normalizeReceiptTimestampMs(raw.receivedAtMs ?? raw.sampledAtMs, nowMs);
  const utilPct = finite(sample.utilPct) ? sample.utilPct : finite(sample.gpuUtilPct) ? sample.gpuUtilPct : null;
  const temperatureC = finite(sample.tempC) ? sample.tempC : finite(sample.temperatureC) ? sample.temperatureC : finite(sample.temperature) ? sample.temperature : null;
  const powerW = finite(sample.powerW) ? sample.powerW : finite(sample.power) ? sample.power : null;
  const fpsSample = raw.fpsSample && typeof raw.fpsSample === 'object' ? raw.fpsSample : null;
  const foregroundProcess = raw.foregroundProcess && typeof raw.foregroundProcess === 'object' ? raw.foregroundProcess : null;
  const readError = typeof raw.readError === 'string' && raw.readError ? raw.readError.slice(0, 240) : null;
  const driverError = raw.driverError === true || sample.driverError === true;
  return {
    sampledAtMs: receivedAtMs,
    receivedAtMs,
    sourceTimestampMs,
    sample: { ...sample, utilPct, temperatureC, powerW },
    utilPct,
    temperatureC,
    powerW,
    fps: finite(fpsSample?.fps) ? fpsSample.fps : null,
    present: finite(fpsSample?.fps) && fpsSample.fps >= 30,
    foreground: Boolean(foregroundProcess?.exePath || foregroundProcess?.pid),
    readError,
    driverError,
  };
}

export function workloadEvidenceOf(counters = {}) {
  const sampleCount = Math.max(0, Number(counters.sampleCount) || 0);
  if (!sampleCount) return false;
  const required = Math.ceil(sampleCount * 0.8);
  return (Number(counters.foregroundCount) || 0) > 0
    && ((Number(counters.presentEvidenceCount) || 0) >= required
      || (Number(counters.utilEvidenceCount) || 0) >= required);
}

export function classifyStabilityRun(input = {}) {
  const sampleCount = Math.max(0, Number(input.sampleCount) || 0);
  const missingCount = Math.max(0, Number(input.missingSampleCount ?? input.missingMetricsCount) || 0);
  const freshCount = Math.max(0, Number(input.freshSampleCount ?? sampleCount - missingCount) || 0);
  const workloadEvidence = input.workloadEvidence === true || workloadEvidenceOf(input);
  const outcomeHint = typeof input.outcomeHint === 'string' ? input.outcomeHint : null;
  let outcome;
  if (input.cancelled === true || outcomeHint === 'cancelled') outcome = 'cancelled';
  else if (input.unavailable === true || outcomeHint === 'unavailable' || sampleCount === 0) outcome = 'unavailable';
  else if (!workloadEvidence) outcome = 'no-workload';
  else if (freshCount / sampleCount < 0.8 || missingCount > 0 || (Number(input.driverErrorCount) || 0) > 0 || (Number(input.thresholdBreaches) || 0) > 0) outcome = 'warning';
  else outcome = 'passed';
  return {
    outcome,
    workloadEvidence,
    freshSampleCount: freshCount,
    sampleCount,
    freshRatio: sampleCount ? freshCount / sampleCount : 0,
    missingMetrics: Array.isArray(input.missingMetrics) ? [...new Set(input.missingMetrics.map(String))].slice(0, 32) : [],
    thresholdBreaches: Math.max(0, Number(input.thresholdBreaches) || 0),
    driverErrorCount: Math.max(0, Number(input.driverErrorCount) || 0),
  };
}

export function normalizeStabilityReport(report = {}) {
  const target = report.target && typeof report.target === 'object' ? report.target : {};
  const deviceKey = normalizeStableDeviceKey(target.deviceKey ?? report.deviceKey);
  if (!deviceKey) return null;
  const sampleCount = Math.max(0, Math.min(100000, Math.round(Number(report.sampleCount) || 0)));
  const missingMetrics = Array.isArray(report.missingMetrics) ? [...new Set(report.missingMetrics.map((item) => String(item).slice(0, 80)))].slice(0, 32) : [];
  const outcome = ['passed', 'warning', 'no-workload', 'unavailable', 'cancelled'].includes(report.outcome) ? report.outcome : 'unavailable';
  return {
    runId: typeof report.runId === 'string' && report.runId.length <= 128 ? report.runId : `stability-${Date.now()}`,
    target: { deviceKey, name: typeof target.name === 'string' ? target.name.slice(0, 160) : null, id: Number.isInteger(target.id) ? target.id : null },
    settingsSnapshot: report.settingsSnapshot && typeof report.settingsSnapshot === 'object' ? { ...report.settingsSnapshot } : {},
    sampleCount,
    missingMetrics,
    workloadEvidence: report.workloadEvidence === true,
    outcome,
    effectiveCadenceMs: clampCadenceMs(report.effectiveCadenceMs) ?? STABILITY_CADENCE_MIN_MS,
    effectiveDurationSec: clampDurationSec(report.effectiveDurationSec) ?? STABILITY_DURATION_MIN_SEC,
    startedAt: typeof report.startedAt === 'string' ? report.startedAt : new Date().toISOString(),
    endedAt: typeof report.endedAt === 'string' ? report.endedAt : new Date().toISOString(),
    reason: typeof report.reason === 'string' ? report.reason.slice(0, 240) : null,
    freshSampleCount: Math.max(0, Math.round(Number(report.freshSampleCount) || 0)),
    thresholdBreaches: Math.max(0, Math.round(Number(report.thresholdBreaches) || 0)),
    driverErrorCount: Math.max(0, Math.round(Number(report.driverErrorCount) || 0)),
  };
}
