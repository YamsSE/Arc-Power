// IGCL can normalize a successful custom VF write. Verify the resulting LIVE
// table and distinguish a valid driver normalization from a no-op or bad read.
const DEFAULT_VF_READBACK_INTERVAL_MS = 100;
const DEFAULT_VF_CONSENSUS_ATTEMPTS = 5;
const DEFAULT_VF_CONSENSUS_QUORUM = 3;
const DEFAULT_VF_POST_WRITE_SETTLE_MS = 3000;

function pointsEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((point, index) => point.Voltage === right[index]?.Voltage
      && point.Frequency === right[index]?.Frequency);
}

/** Read a stable VF snapshot without allowing a one-off driver response to
 * become application state or a write before-image. */
export async function readStableVfCurve({
  readCurve,
  maxAttempts = DEFAULT_VF_CONSENSUS_ATTEMPTS,
  quorum = DEFAULT_VF_CONSENSUS_QUORUM,
  pollIntervalMs = DEFAULT_VF_READBACK_INTERVAL_MS,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof readCurve !== 'function') {
    return { ok: false, points: [], errorCode: 'readback-unverified', message: 'VF read callback is unavailable.' };
  }
  const attempts = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : DEFAULT_VF_CONSENSUS_ATTEMPTS;
  const required = Number.isInteger(quorum) && quorum > 0 ? quorum : DEFAULT_VF_CONSENSUS_QUORUM;
  if (required > attempts) {
    return { ok: false, points: [], errorCode: 'readback-unverified', message: 'LIVE VF stability quorum exceeds the read limit.' };
  }
  const intervalMs = Number.isFinite(pollIntervalMs) && pollIntervalMs >= 0 ? pollIntervalMs : 0;
  const observations = [];
  let latestReadOk = false;
  let latestResult = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await readCurve();
      latestResult = result;
      latestReadOk = result?.ok === true && Array.isArray(result.points);
      if (latestReadOk) observations.push(result.points);
    } catch {
      latestReadOk = false;
      latestResult = null;
    }
    if (attempt < attempts - 1 && intervalMs > 0) await wait(intervalMs);
  }
  const counts = [];
  for (const points of observations) {
    const match = counts.find((entry) => pointsEqual(entry.points, points));
    if (match) match.count += 1;
    else counts.push({ points, count: 1 });
  }
  const stable = counts.find((entry) => entry.count >= required);
  const latestObservation = observations.at(-1);
  // The most recent native read must belong to the accepted quorum. This
  // rejects a stale majority if the driver transitions late in the poll
  // window, even when the earlier curve still accounts for enough samples.
  if (stable && latestReadOk && pointsEqual(stable.points, latestObservation)) {
    return { ok: true, points: stable.points.map((point) => ({ ...point })), consensus: stable.count };
  }
  if (observations.length === 0) {
    return {
      ok: false,
      points: [],
      errorCode: 'readback-unverified',
      result: latestResult?.result,
      message: latestResult?.message ?? 'The VF curve could not be read during the stability check.',
    };
  }
  return {
    ok: false,
    points: [],
    errorCode: 'readback-unstable',
    message: `The VF curve did not produce a stable ${required}-of-${attempts} read quorum through the latest read. No curve state was accepted.`,
  };
}

/** Read one LIVE sample for an apply transaction. Unlike passive state reads,
 * apply before/after images must follow IGCL's write-then-read semantics and
 * must not be blocked by a repeated-read quorum. Semantic curve validation is
 * performed by the caller before accepting this sample. */
export async function readVfCurveOnce({ readCurve } = {}) {
  if (typeof readCurve !== 'function') {
    return { ok: false, points: [], errorCode: 'readback-unverified', message: 'LIVE VF read callback is unavailable.' };
  }
  try {
    const result = await readCurve();
    if (result?.ok === true && Array.isArray(result.points)) {
      return { ok: true, points: result.points.map((point) => ({ ...point })) };
    }
    return {
      ok: false,
      points: [],
      errorCode: result?.errorCode ?? 'readback-unverified',
      message: result?.message ?? 'The driver did not return a LIVE VF curve.',
    };
  } catch (error) {
    return {
      ok: false,
      points: [],
      errorCode: 'readback-unverified',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function toCanonicalCurve(points) {
  return points.map((point) => ({ voltageV: point.Voltage / 1000, freqMhz: point.Frequency }));
}

/** Verify a driver's LIVE curve after a custom VF write. */
export function validateVfCurveReadback({ readBack, requestedPoints, liveBefore, curveRange } = {}) {
  if (!readBack?.ok) {
    return {
      ok: false,
      errorCode: readBack?.errorCode ?? 'io-failed',
      message: readBack?.errorCode === 'readback-unstable'
        ? `VF curve write succeeded, but ${readBack.message}`
        : `VF curve write succeeded but read-back failed: ${readBack?.message ?? 'unknown read failure'}`,
    };
  }
  if (!Array.isArray(requestedPoints)) {
    return { ok: false, errorCode: 'out-of-range', message: 'The requested VF curve payload is invalid.' };
  }
  if (!Array.isArray(readBack.points)
    || readBack.points.length < 2
    || readBack.points.length > (Number.isFinite(curveRange?.maxPoints) ? curveRange.maxPoints : 32)) {
    return { ok: false, errorCode: 'driver-invalid-readback', message: 'The driver returned no LIVE VF point table.' };
  }

  let previousVoltage = 0;
  let previousFrequency = 0;
  for (let index = 0; index < readBack.points.length; index += 1) {
    const point = readBack.points[index];
    const inRange = Number.isFinite(point?.Voltage) && Number.isFinite(point?.Frequency)
      && point.Voltage / 1000 >= curveRange.voltageMinV
      && point.Voltage / 1000 <= curveRange.voltageMaxV
      && point.Frequency >= curveRange.freqMinMhz
      && point.Frequency <= curveRange.freqMaxMhz;
    if (!inRange || (index > 0
      && (point.Voltage <= previousVoltage || point.Frequency < previousFrequency))) {
      return {
        ok: false,
        errorCode: 'driver-invalid-readback',
        message: 'VF curve read-back is not a valid ordered LIVE curve within the driver range.',
      };
    }
    previousVoltage = point.Voltage;
    previousFrequency = point.Frequency;
  }

  const appliedCurve = toCanonicalCurve(readBack.points);
  const hasBeforeImage = liveBefore?.ok === true && Array.isArray(liveBefore.points);
  const requestedDiffersFromBefore = hasBeforeImage && !pointsEqual(requestedPoints, liveBefore.points);
  const liveDiffersFromBefore = hasBeforeImage && !pointsEqual(readBack.points, liveBefore.points);
  if (readBack.points.length !== requestedPoints.length) {
    return {
      ok: false,
      errorCode: 'driver-invalid-readback',
      driverAdjusted: false,
      appliedCurve,
      message: `The driver returned ${readBack.points.length} LIVE VF points for a ${requestedPoints.length}-point request. The requested draft was kept unchanged.`,
    };
  }

  if (pointsEqual(readBack.points, requestedPoints)) {
    return { ok: true, exact: true, normalized: false, appliedCurve };
  }

  if (requestedDiffersFromBefore && liveDiffersFromBefore) {
    // Only call a changed value driver normalization when IGCL reported the
    // corresponding native step. Unknown step metadata means exact match is
    // the only evidence-backed acceptance rule; never invent a 10 MHz step.
    const voltageToleranceMv = Number.isFinite(curveRange?.voltageStepV) && curveRange.voltageStepV > 0
      ? Math.max(1, Math.round(curveRange.voltageStepV * 1000))
      : 0;
    const frequencyToleranceMhz = Number.isFinite(curveRange?.frequencyStepMhz) && curveRange.frequencyStepMhz > 0
      ? Math.max(1, Math.round(curveRange.frequencyStepMhz))
      : 0;
    const outsideNormalizationTolerance = readBack.points.findIndex((point, index) =>
      Math.abs(point.Voltage - requestedPoints[index].Voltage) > voltageToleranceMv
      || Math.abs(point.Frequency - requestedPoints[index].Frequency) > frequencyToleranceMhz);
    if (outsideNormalizationTolerance >= 0) {
      const index = outsideNormalizationTolerance;
      return {
        ok: false,
        exact: false,
        normalized: false,
        readBackEqual: false,
        driverAdjusted: true,
        errorCode: 'driver-adjusted',
        appliedCurve,
        message: `The driver returned a stable LIVE VF curve outside the one-step normalization tolerance. Point ${index + 1} requested ${requestedPoints[index].Voltage} mV / ${requestedPoints[index].Frequency} MHz; LIVE is ${readBack.points[index].Voltage} mV / ${readBack.points[index].Frequency} MHz. The requested draft was kept unchanged.`,
      };
    }
    return {
      ok: true,
      exact: false,
      normalized: true,
      readBackEqual: false,
      driverAdjusted: true,
      appliedCurve,
      message: 'Applied. The driver adjusted the requested VF curve; the editor now shows the LIVE curve.',
    };
  }
  if (hasBeforeImage && liveDiffersFromBefore) {
    return {
      ok: false,
      exact: false,
      normalized: false,
      driverAdjusted: false,
      errorCode: 'readback-unverified',
      appliedCurve,
      message: 'The LIVE VF curve changed during apply verification, but does not exactly match the request. Your requested draft was kept unchanged.',
    };
  }

  const silentNoop = requestedDiffersFromBefore && !liveDiffersFromBefore;
  const mismatch = readBack.points.findIndex((point, index) =>
    point.Voltage !== requestedPoints[index].Voltage
      || point.Frequency !== requestedPoints[index].Frequency);
  const mismatchIndex = mismatch < 0 ? 0 : mismatch;
  const message = silentNoop
    ? `IGCL reported success, but the LIVE VF curve remained unchanged during verification. Point ${mismatchIndex + 1} requested ${requestedPoints[mismatchIndex].Voltage} mV / ${requestedPoints[mismatchIndex].Frequency} MHz; LIVE remains ${readBack.points[mismatchIndex].Voltage} mV / ${readBack.points[mismatchIndex].Frequency} MHz. No change was observed.`
    : !hasBeforeImage
      ? 'The LIVE VF curve differs from the request, but the before-image could not be verified. Your requested draft was kept unchanged.'
      : 'The requested VF curve matched the before-image, but the driver returned a different LIVE curve. The apply could not be verified, and your requested draft was kept unchanged.';
  return {
    ok: false,
    exact: false,
    normalized: false,
      driverAdjusted: requestedDiffersFromBefore && liveDiffersFromBefore,
    silentNoop,
    errorCode: silentNoop ? 'driver-noop' : 'readback-unverified',
    appliedCurve,
    message,
  };
}

/**
 * Verify a VF write using a stable LIVE quorum after a bounded settle delay.
 * A native write is never replayed here.
 */
export async function readVfCurveAfterWrite({
  readCurve,
  requestedPoints,
  liveBefore,
  curveRange,
  maxAttempts = DEFAULT_VF_CONSENSUS_ATTEMPTS,
  quorum = DEFAULT_VF_CONSENSUS_QUORUM,
  pollIntervalMs = DEFAULT_VF_READBACK_INTERVAL_MS,
  settleDelayMs = DEFAULT_VF_POST_WRITE_SETTLE_MS,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof readCurve !== 'function') {
    return validateVfCurveReadback({
      readBack: { ok: false, message: 'LIVE VF read callback is unavailable' },
      requestedPoints,
      liveBefore,
      curveRange,
    });
  }
  // The B580 driver can return a valid-looking transitional table shortly
  // after a successful write, then settle to a different LIVE curve. Never
  // publish that one-shot sample as the applied state. Wait for the native
  // write to settle, then require a repeated LIVE quorum without replaying
  // the setter.
  const requestedSettleMs = Number.isFinite(settleDelayMs) && settleDelayMs >= 0 ? settleDelayMs : 0;
  const boundedSettleMs = Math.min(requestedSettleMs, 5000);
  if (boundedSettleMs > 0) await wait(boundedSettleMs);
  const stable = await readStableVfCurve({
    readCurve,
    maxAttempts,
    quorum,
    pollIntervalMs,
    wait,
  });
  const readBack = stable.ok
    ? stable
    : {
      ...stable,
      errorCode: stable.errorCode ?? 'readback-unstable',
    };
  return validateVfCurveReadback({ readBack, requestedPoints, liveBefore, curveRange });
}
