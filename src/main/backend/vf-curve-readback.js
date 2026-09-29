// A successful native return is not enough to claim the requested curve
// landed. Verify LIVE: exact points are exact success; a valid changed curve
// is a normalized success only when the before-image proves the write changed
// the active curve. Always return a valid read-back so the editor can show
// what the driver currently has, even when the apply cannot be verified.
// Bound success to the largest per-point change in the captured B580 LIVE
// trace. Do not accept an arbitrary valid-but-different curve as normalized.
const B580_NORMALIZED_VOLTAGE_DELTA_MV = 10;
const B580_NORMALIZED_FREQUENCY_DELTA_MHZ = 90;
const DEFAULT_VF_READBACK_ATTEMPTS = 21;
const DEFAULT_VF_READBACK_INTERVAL_MS = 100;

function pointsEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((point, index) => point.Voltage === right[index]?.Voltage
      && point.Frequency === right[index]?.Frequency);
}

function toCanonicalCurve(points) {
  return points.map((point) => ({ voltageV: point.Voltage / 1000, freqMhz: point.Frequency }));
}

/** Verify a driver's LIVE curve after a custom VF write. */
export function validateVfCurveReadback({ readBack, requestedPoints, liveBefore, curveRange, allowDriverNormalization = false } = {}) {
  if (!readBack?.ok) {
    return { ok: false, message: `VF curve write succeeded but read-back failed: ${readBack?.message ?? 'unknown read failure'}` };
  }
  if (!Array.isArray(requestedPoints) || readBack.points?.length !== requestedPoints.length) {
    return { ok: false, message: `VF curve read-back ${readBack.points?.length ?? 0} points != requested ${requestedPoints?.length ?? 0}` };
  }

  let previousVoltage = 0;
  let previousFrequency = 0;
  for (let index = 0; index < readBack.points.length; index += 1) {
    const point = readBack.points[index];
    const inRange = Number.isFinite(point.Voltage) && Number.isFinite(point.Frequency)
      && point.Voltage / 1000 >= curveRange.voltageMinV
      && point.Voltage / 1000 <= curveRange.voltageMaxV
      && point.Frequency >= curveRange.freqMinMhz
      && point.Frequency <= curveRange.freqMaxMhz;
    if (!inRange || (index > 0
      && (point.Voltage <= previousVoltage || point.Frequency < previousFrequency))) {
      return { ok: false, message: 'VF curve read-back is not a valid ordered LIVE curve within the driver range' };
    }
    previousVoltage = point.Voltage;
    previousFrequency = point.Frequency;
  }

  const appliedCurve = toCanonicalCurve(readBack.points);
  if (pointsEqual(readBack.points, requestedPoints)) {
    return { ok: true, exact: true, normalized: false, appliedCurve };
  }

  const changedRequestedCurve = liveBefore?.ok === true && !pointsEqual(requestedPoints, liveBefore.points);
  const changedLiveCurve = liveBefore?.ok === true && !pointsEqual(readBack.points, liveBefore.points);
  if (liveBefore?.ok === true && changedRequestedCurve && changedLiveCurve) {
    const withinObservedB580Envelope = allowDriverNormalization === true
      && readBack.points.every((point, index) =>
        Math.abs(point.Voltage - requestedPoints[index].Voltage) <= B580_NORMALIZED_VOLTAGE_DELTA_MV
        && Math.abs(point.Frequency - requestedPoints[index].Frequency) <= B580_NORMALIZED_FREQUENCY_DELTA_MHZ);
    if (withinObservedB580Envelope) {
      return {
        ok: true,
        exact: false,
        normalized: true,
        driverAdjusted: true,
        appliedCurve,
        message: 'The driver applied a normalized VF curve. The editor now shows the active LIVE curve.',
      };
    }
    const envelopeLabel = allowDriverNormalization === true ? 'the observed B580 normalization envelope' : 'the supported normalization policy';
    return {
      ok: false,
      exact: false,
      normalized: false,
      driverAdjusted: true,
      errorCode: 'driver-adjustment-out-of-range',
      appliedCurve,
      message: `The driver returned a VF curve outside ${envelopeLabel}. The editor now shows the active LIVE curve, but this apply was not accepted.`,
    };
  }
  if (liveBefore?.ok === true && changedLiveCurve) {
    return {
      ok: false,
      exact: false,
      normalized: false,
      driverAdjusted: true,
      errorCode: 'driver-adjustment-out-of-range',
      appliedCurve,
      message: 'The LIVE VF curve changed although the request matched the before-image. The editor now shows the active curve, but this apply was not accepted.',
    };
  }

  const mismatch = readBack.points.findIndex((point, index) =>
    point.Voltage !== requestedPoints[index].Voltage
      || point.Frequency !== requestedPoints[index].Frequency);
  const index = mismatch < 0 ? 0 : mismatch;
  const silentNoop = liveBefore?.ok === true && changedRequestedCurve && !changedLiveCurve;
  const message = silentNoop
    ? `IGCL reported success, but the LIVE curve remained unchanged during verification. Point ${index + 1} requested ${requestedPoints[index].Voltage} mV / ${requestedPoints[index].Frequency} MHz; LIVE remains ${readBack.points[index].Voltage} mV / ${readBack.points[index].Frequency} MHz. No change was observed.`
    : liveBefore?.ok !== true
      ? 'The driver returned a different LIVE VF curve, but the before-image could not be verified. The editor now shows the active curve.'
        : !changedRequestedCurve
          ? 'The requested VF curve matched the before-image, but the driver returned a different LIVE curve. Review the active curve before applying again.'
        : `VF curve point ${index} read-back ${readBack.points[index].Voltage} mV / ${readBack.points[index].Frequency} MHz != requested ${requestedPoints[index].Voltage} mV / ${requestedPoints[index].Frequency} MHz`;
  return {
    ok: false,
    exact: false,
    normalized: false,
    driverAdjusted: !silentNoop,
    silentNoop,
    errorCode: silentNoop ? 'driver-noop' : 'io-failed',
    appliedCurve,
    message,
  };
}

/**
 * Verify a VF write while allowing the driver's LIVE table to settle. This
 * retries read-only LIVE reads only when the requested curve differs from the
 * before-image and the driver still returns that exact before-image. The
 * native write is never replayed here.
 */
export async function readVfCurveAfterWrite({
  readCurve,
  requestedPoints,
  liveBefore,
  curveRange,
  allowDriverNormalization = false,
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
      allowDriverNormalization,
    });
  }
  const attempts = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 1;
  const intervalMs = Number.isFinite(pollIntervalMs) && pollIntervalMs >= 0 ? pollIntervalMs : 0;
  let validation = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const readBack = await readCurve();
    validation = validateVfCurveReadback({
      readBack,
      requestedPoints,
      liveBefore,
      curveRange,
      allowDriverNormalization,
    });
    const awaitingLiveUpdate = readBack?.ok === true
      && liveBefore?.ok === true
      && !pointsEqual(requestedPoints, liveBefore.points)
      && pointsEqual(readBack.points, liveBefore.points);
    if (validation.ok || !awaitingLiveUpdate || attempt === attempts - 1) return validation;
    await wait(intervalMs);
  }
  return validation;
}
