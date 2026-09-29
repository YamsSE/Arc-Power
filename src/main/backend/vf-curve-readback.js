// A successful native return is not enough to claim the requested curve
// landed exactly. Verify LIVE and distinguish an actual driver adjustment
// from an I/O failure. The caller invokes this verifier only after the native
// setter succeeds. Only an exact point-for-point LIVE match is verified as
// applied; mismatches retain the requested draft and report the observed data.
const DEFAULT_VF_READBACK_ATTEMPTS = 21;
const DEFAULT_VF_READBACK_INTERVAL_MS = 100;
const DEFAULT_VF_CONSENSUS_ATTEMPTS = 5;
const DEFAULT_VF_CONSENSUS_QUORUM = 3;

function pointsEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((point, index) => point.Voltage === right[index]?.Voltage
      && point.Frequency === right[index]?.Frequency);
}

/** Read a stable LIVE snapshot without allowing a one-off driver response to
 * become application state or a write before-image. STOCK reads intentionally
 * remain independent and must not be mixed into this consensus. */
export async function readStableVfCurve({
  readCurve,
  maxAttempts = DEFAULT_VF_CONSENSUS_ATTEMPTS,
  quorum = DEFAULT_VF_CONSENSUS_QUORUM,
  pollIntervalMs = DEFAULT_VF_READBACK_INTERVAL_MS,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof readCurve !== 'function') {
    return { ok: false, points: [], errorCode: 'readback-unverified', message: 'LIVE VF read callback is unavailable.' };
  }
  const attempts = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : DEFAULT_VF_CONSENSUS_ATTEMPTS;
  const required = Number.isInteger(quorum) && quorum > 0 ? quorum : DEFAULT_VF_CONSENSUS_QUORUM;
  if (required > attempts) {
    return { ok: false, points: [], errorCode: 'readback-unverified', message: 'LIVE VF stability quorum exceeds the read limit.' };
  }
  const intervalMs = Number.isFinite(pollIntervalMs) && pollIntervalMs >= 0 ? pollIntervalMs : 0;
  const observations = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await readCurve();
    if (result?.ok === true && Array.isArray(result.points)) observations.push(result.points);
    if (attempt < attempts - 1 && intervalMs > 0) await wait(intervalMs);
  }
  const counts = [];
  for (const points of observations) {
    const match = counts.find((entry) => pointsEqual(entry.points, points));
    if (match) match.count += 1;
    else counts.push({ points, count: 1 });
  }
  const stable = counts.find((entry) => entry.count >= required);
  if (stable) return { ok: true, points: stable.points.map((point) => ({ ...point })), consensus: stable.count };
  return {
    ok: false,
    points: [],
    errorCode: 'readback-unstable',
    message: `The LIVE VF curve did not produce a stable ${required}-of-${attempts} read quorum. No curve state was accepted.`,
  };
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
    const verifiedDriverChange = requestedDiffersFromBefore && liveDiffersFromBefore;
    return {
      ok: false,
      errorCode: verifiedDriverChange ? 'driver-adjusted' : 'readback-unverified',
      driverAdjusted: verifiedDriverChange,
      appliedCurve,
      message: `The driver returned ${readBack.points.length} LIVE VF points for a ${requestedPoints.length}-point request. The requested draft was kept unchanged.`,
    };
  }

  if (pointsEqual(readBack.points, requestedPoints)) {
    return { ok: true, exact: true, normalized: false, appliedCurve };
  }

  if (requestedDiffersFromBefore && liveDiffersFromBefore) {
    const mismatch = readBack.points.findIndex((point, index) =>
      point.Voltage !== requestedPoints[index].Voltage
        || point.Frequency !== requestedPoints[index].Frequency);
    const index = Math.max(0, mismatch);
    const requested = requestedPoints[index];
    const actual = readBack.points[index];
    return {
      ok: false,
      exact: false,
      normalized: false,
      driverAdjusted: true,
      errorCode: 'driver-adjusted',
      appliedCurve,
      message: `The driver returned a different LIVE VF curve after the write: point ${index + 1} is ${actual.Voltage} mV / ${actual.Frequency} MHz, while the request was ${requested.Voltage} mV / ${requested.Frequency} MHz. The apply was not verified, and your requested draft was kept unchanged.`,
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
 * Verify a VF write while allowing the driver's LIVE table to settle. Poll
 * only with read-only calls until an exact match appears or the bounded
 * settle window expires. A native write is never replayed here.
 */
export async function readVfCurveAfterWrite({
  readCurve,
  requestedPoints,
  liveBefore,
  curveRange,
  maxAttempts = DEFAULT_VF_READBACK_ATTEMPTS,
  pollIntervalMs = DEFAULT_VF_READBACK_INTERVAL_MS,
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
  const attempts = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 1;
  const intervalMs = Number.isFinite(pollIntervalMs) && pollIntervalMs >= 0 ? pollIntervalMs : 0;
  let validation = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const readBack = await readStableVfCurve({
      readCurve,
      maxAttempts: DEFAULT_VF_CONSENSUS_ATTEMPTS,
      quorum: DEFAULT_VF_CONSENSUS_QUORUM,
      // Keep each quorum batch immediate; the outer loop owns the bounded
      // settle cadence so five-sample verification retains its two-second cap.
      pollIntervalMs: 0,
      wait,
    });
    validation = validateVfCurveReadback({
      readBack,
      requestedPoints,
      liveBefore,
      curveRange,
    });
    const exactMatch = validation.ok === true && validation.exact === true;
    // A quorum miss means LIVE is still transient. Keep sampling within the
    // bounded settle window, but never replay the native setter. A stable,
    // semantically invalid table is terminal because another identical
    // quorum cannot make that observed table valid.
    const mayStillSettle = validation.errorCode === 'readback-unstable'
      || (readBack?.ok === true && validation.errorCode !== 'driver-invalid-readback');
    if (exactMatch || !mayStillSettle || attempt === attempts - 1) return validation;
    await wait(intervalMs);
  }
  return validation;
}
