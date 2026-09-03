// Arc Power - voltage/frequency curve editor math (pure, DOM-free).
//
// The driver may expose a table larger than the compact editor should show.
// Keep the UI at the same ten-point scale as Fan Curve while preserving the
// end points and the driver's required strictly ascending voltage/frequency
// order. The renderer owns the hover/click presentation; this module owns
// the clamping and point-count rules so those rules are testable.

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
 * Normalize a driver/profile curve for the compact editor. Curves longer
 * than the editor limit are evenly downsampled, always retaining endpoints.
 * Invalid or non-ascending input degrades to the nearest legal curve rather
 * than allowing an apply payload the backend must reject.
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
    if (!previous || (point.voltageV > previous.voltageV && point.freqMhz > previous.freqMhz)) {
      legal.push(point);
    }
  }
  if (legal.length < VF_MIN_POINTS) return seedVfCurve(range);
  if (legal.length <= maxPoints) return legal.map((point) => ({ ...point }));

  const stride = (legal.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => ({ ...legal[Math.round(index * stride)] }));
}

/** Move one point while keeping both dimensions strictly ascending. */
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
