// Arc Power - voltage/frequency curve editor math (pure, DOM-free).
//
// The driver may expose a table larger than the compact editor should show.
// Keep the UI at the same ten-point scale as Fan Curve while preserving the
// end points and the driver's required ascending voltage/increasing frequency
// order. Battlemage's read-only simplified table can end with a shared
// maximum-frequency plateau, so the editor keeps the point but repairs the
// plateau before a custom write. The renderer owns the hover/click
// presentation; this module owns the clamping and point-count rules so those
// rules are testable.

import type { VfCurveRange } from '../types.ts';

export interface VfCurvePoint {
  voltageV: number;
  freqMhz: number;
}

export const VF_EDITOR_MAX_POINTS = 10;
export const VF_MIN_POINTS = 2;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function legalMaxPoints(range: VfCurveRange, requested: number): number {
  const driverMax = Number.isFinite(range.maxPoints) && range.maxPoints > 0
    ? Math.floor(range.maxPoints)
    : VF_EDITOR_MAX_POINTS;
  return Math.max(VF_MIN_POINTS, Math.min(VF_EDITOR_MAX_POINTS, driverMax, Math.floor(requested)));
}

function sanitizePoint(point: VfCurvePoint, range: VfCurveRange): VfCurvePoint | null {
  if (!point || !Number.isFinite(point.voltageV) || !Number.isFinite(point.freqMhz)) return null;
  return {
    voltageV: Number(clamp(point.voltageV, range.voltageMinV, range.voltageMaxV).toFixed(3)),
    freqMhz: Math.round(clamp(point.freqMhz, range.freqMinMhz, range.freqMaxMhz)),
  };
}

function seedVfCurve(range: VfCurveRange): VfCurvePoint[] {
  return [
    { voltageV: Number(range.voltageMinV.toFixed(3)), freqMhz: Math.round(range.freqMinMhz) },
    { voltageV: Number(range.voltageMaxV.toFixed(3)), freqMhz: Math.round(range.freqMaxMhz) },
  ];
}

/**
 * Convert a valid curve into the integer-MHz shape accepted by the native
 * custom-curve writer. IGCL can expose equal adjacent frequencies in STOCK or
 * LIVE reads, but ctlOverclockWriteCustomVFCurve requires strictly increasing
 * frequencies. Keep the driver's voltage positions and point count intact;
 * only move frequencies by the smallest bounded amount needed to make the
 * payload writable.
 */
export function prepareVfCurveForDriver(
  points: VfCurvePoint[],
  range: VfCurveRange,
): VfCurvePoint[] | null {
  if (!Array.isArray(points) || points.length < VF_MIN_POINTS) return null;
  const minFrequency = Math.ceil(range.freqMinMhz);
  const maxFrequency = Math.floor(range.freqMaxMhz);
  if (!Number.isFinite(minFrequency) || !Number.isFinite(maxFrequency)
    || minFrequency > maxFrequency || points.length > maxFrequency - minFrequency + 1) {
    return null;
  }

  const prepared = points.map((point) => ({
    ...point,
    freqMhz: Math.round(clamp(point.freqMhz, minFrequency, maxFrequency)),
  }));

  // Forward repair preserves the requested curve everywhere except flat or
  // descending steps. A backward pass keeps the tail inside the driver's max
  // when a plateau already sits at the upper boundary.
  for (let index = 1; index < prepared.length; index += 1) {
    prepared[index].freqMhz = Math.max(prepared[index].freqMhz, prepared[index - 1].freqMhz + 1);
  }
  if (prepared.at(-1)!.freqMhz > maxFrequency) {
    prepared[prepared.length - 1].freqMhz = maxFrequency;
    for (let index = prepared.length - 2; index >= 0; index -= 1) {
      prepared[index].freqMhz = Math.min(prepared[index].freqMhz, prepared[index + 1].freqMhz - 1);
    }
  }
  if (prepared[0].freqMhz < minFrequency) {
    prepared[0].freqMhz = minFrequency;
    for (let index = 1; index < prepared.length; index += 1) {
      prepared[index].freqMhz = Math.max(prepared[index].freqMhz, prepared[index - 1].freqMhz + 1);
    }
  }
  if (prepared.at(-1)!.freqMhz > maxFrequency
    || prepared[0].freqMhz < minFrequency
    || prepared.some((point, index) => index > 0 && point.freqMhz <= prepared[index - 1].freqMhz)) {
    return null;
  }
  return prepared;
}

/**
 * Normalize a driver/profile curve for the compact editor. Curves longer
 * than the editor limit are evenly downsampled, always retaining endpoints.
 * Invalid input degrades to the nearest legal curve rather than allowing an
 * apply payload the backend must reject. Equal adjacent frequencies from the
 * driver's read-only table are repaired to the strictly increasing shape the
 * custom write API accepts.
 */
export function normalizeVfCurvePoints(
  points: VfCurvePoint[] | null | undefined,
  range: VfCurveRange,
  requestedMax: number = VF_EDITOR_MAX_POINTS,
): VfCurvePoint[] {
  const maxPoints = legalMaxPoints(range, requestedMax);
  const sorted = (Array.isArray(points) ? points : [])
    .map((point) => sanitizePoint(point, range))
    .filter((point): point is VfCurvePoint => point !== null)
    .sort((a, b) => a.voltageV - b.voltageV || a.freqMhz - b.freqMhz);
  const legal: VfCurvePoint[] = [];
  for (const point of sorted) {
    const previous = legal[legal.length - 1];
    if (!previous || point.voltageV > previous.voltageV) {
      legal.push(point);
    }
  }
  if (legal.length < VF_MIN_POINTS) return seedVfCurve(range);

  const compact = legal.length <= maxPoints
    ? legal.map((point) => ({ ...point }))
    : (() => {
      const stride = (legal.length - 1) / (maxPoints - 1);
      return Array.from({ length: maxPoints }, (_, index) => ({ ...legal[Math.round(index * stride)] }));
    })();

  return prepareVfCurveForDriver(compact, range) ?? seedVfCurve(range);
}

/** Move one point while keeping voltage ascending and frequency increasing. */
export function moveVfPoint(
  points: VfCurvePoint[],
  index: number,
  voltageV: number,
  freqMhz: number,
  range: VfCurveRange,
): VfCurvePoint[] {
  if (index < 0 || index >= points.length) return points.map((point) => ({ ...point }));
  const next = points.map((point) => ({ ...point }));
  const current = next[index];
  const previous = next[index - 1];
  const following = next[index + 1];
  const voltageMin = Math.max(range.voltageMinV, previous ? previous.voltageV + 0.001 : range.voltageMinV);
  const voltageMax = Math.min(range.voltageMaxV, following ? following.voltageV - 0.001 : range.voltageMaxV);
  const freqMin = Math.max(range.freqMinMhz, previous ? previous.freqMhz + 1 : range.freqMinMhz);
  const freqMax = Math.min(range.freqMaxMhz, following ? following.freqMhz - 1 : range.freqMaxMhz);
  if (voltageMin > voltageMax || freqMin > freqMax) return next;
  next[index] = {
    voltageV: Number(clamp(Number.isFinite(voltageV) ? voltageV : current.voltageV, voltageMin, voltageMax).toFixed(3)),
    freqMhz: Math.round(clamp(Number.isFinite(freqMhz) ? freqMhz : current.freqMhz, freqMin, freqMax)),
  };
  return next;
}

/** Move only a point's frequency, preserving the driver's voltage grid. */
export function moveVfFrequencyPoint(
  points: VfCurvePoint[],
  index: number,
  freqMhz: number,
  range: VfCurveRange,
): VfCurvePoint[] {
  if (index < 0 || index >= points.length) return points.map((point) => ({ ...point }));
  const next = points.map((point) => ({ ...point }));
  const current = next[index];
  const previous = next[index - 1];
  const following = next[index + 1];
  const freqMin = Math.max(range.freqMinMhz, previous ? previous.freqMhz + 1 : range.freqMinMhz);
  const freqMax = Math.min(range.freqMaxMhz, following ? following.freqMhz - 1 : range.freqMaxMhz);
  if (freqMin > freqMax) return next;
  next[index] = {
    ...current,
    freqMhz: Math.round(clamp(Number.isFinite(freqMhz) ? freqMhz : current.freqMhz, freqMin, freqMax)),
  };
  return next;
}

/** Insert a point halfway through the widest legal voltage gap. */
export function addVfPointAtMidGap(
  points: VfCurvePoint[],
  range: VfCurveRange,
  requestedMax: number = VF_EDITOR_MAX_POINTS,
): VfCurvePoint[] | null {
  const maxPoints = legalMaxPoints(range, requestedMax);
  if (points.length >= maxPoints) return null;
  let gapIndex = -1;
  let gapSize = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const gap = points[index + 1].voltageV - points[index].voltageV;
    if (gap > gapSize && points[index + 1].freqMhz - points[index].freqMhz > 1) {
      gapSize = gap;
      gapIndex = index;
    }
  }
  if (gapIndex < 0) return null;
  const previous = points[gapIndex];
  const following = points[gapIndex + 1];
  const added: VfCurvePoint = {
    voltageV: Number(((previous.voltageV + following.voltageV) / 2).toFixed(3)),
    freqMhz: Math.round((previous.freqMhz + following.freqMhz) / 2),
  };
  if (!(added.voltageV > previous.voltageV && added.voltageV < following.voltageV
    && added.freqMhz > previous.freqMhz && added.freqMhz < following.freqMhz)) return null;
  return [...points.slice(0, gapIndex + 1), added, ...points.slice(gapIndex + 1)];
}

/** Remove a point without allowing the driver payload to become invalid. */
export function removeVfPoint(points: VfCurvePoint[], index: number): VfCurvePoint[] {
  if (points.length <= VF_MIN_POINTS) return points.map((point) => ({ ...point }));
  return points.filter((_, pointIndex) => pointIndex !== index);
}

export function vfVoltageMv(voltageV: number): number {
  return Math.round(voltageV * 1000);
}

export function vfCurvePointLabel(point: VfCurvePoint, index: number): string {
  return `${vfVoltageMv(point.voltageV)} mV @ ${Math.round(point.freqMhz)} MHz · #${index + 1}`;
}
