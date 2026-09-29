// Arc Power - voltage/frequency curve editor math (pure, DOM-free).
//
// The driver may expose a table larger than the compact editor should show.
// Keep the UI at the same ten-point scale as Fan Curve while preserving the
// end points and the driver's required ascending voltage/non-decreasing
// frequency order. Battlemage's native simplified table can end with a shared
// maximum-frequency plateau, so the editor keeps that native shape. The renderer owns the hover/click
// presentation; this module owns the clamping and point-count rules so those
// rules are testable.

import type { VfCurveRange } from '../types.ts';

export interface VfCurvePoint {
  voltageV: number;
  freqMhz: number;
}

export const VF_EDITOR_MAX_POINTS = 10;
export const VF_MIN_POINTS = 2;

/** Compare two curves by their native point coordinates and frequencies. */
export function sameVfCurve(
  left: VfCurvePoint[] | null | undefined,
  right: VfCurvePoint[] | null | undefined,
  voltageToleranceV = 0.0005,
  frequencyToleranceMhz = 1,
): boolean {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((point, index) => {
      const other = right[index];
      return Number.isFinite(point?.voltageV) && Number.isFinite(point?.freqMhz)
        && Number.isFinite(other?.voltageV) && Number.isFinite(other?.freqMhz)
        && Math.abs(point.voltageV - other.voltageV) <= voltageToleranceV
        && Math.abs(point.freqMhz - other.freqMhz) <= frequencyToleranceMhz;
    });
}

/** Sync external device/profile changes only when the editor has no local draft. */
export function shouldSyncVfCurveFromState(
  draft: VfCurvePoint[] | null | undefined,
  applied: VfCurvePoint[] | null | undefined,
  hasPendingNativeApply = false,
): boolean {
  return !hasPendingNativeApply && sameVfCurve(draft, applied, 0, 0);
}

/** True only when an exact IGCL write is needed to make LIVE equal requested. */
export function vfCurveNeedsWrite(
  requested: VfCurvePoint[] | null | undefined,
  live: VfCurvePoint[] | null | undefined,
): boolean {
  return !sameVfCurve(requested, live, 0, 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function legalMaxPoints(range: VfCurveRange, requested: number): number {
  const driverMax = Number.isFinite(range.maxPoints) && range.maxPoints > 0
    ? Math.floor(range.maxPoints)
    : VF_EDITOR_MAX_POINTS;
  return Math.max(VF_MIN_POINTS, Math.min(VF_EDITOR_MAX_POINTS, driverMax, Math.floor(requested)));
}

/**
 * Convert a valid curve into the integer-MHz shape accepted by the native
 * custom-curve writer. IGCL exposes equal adjacent frequencies in STOCK and
 * LIVE reads (the B580's final points are a native maximum-frequency
 * plateau), and the writer accepts that non-decreasing shape. Keep the
 * requested coordinates and point order intact. Inputs that need clamping,
 * rounding, or monotonic repair are rejected so a point can never silently
 * move to another coordinate before reaching IGCL.
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

  if (!points.every((point, index) => point
    && Number.isFinite(point.voltageV)
    && Number.isFinite(point.freqMhz)
    && point.voltageV >= range.voltageMinV
    && point.voltageV <= range.voltageMaxV
    && Math.abs(point.voltageV * 1000 - Math.round(point.voltageV * 1000)) < 1e-7
    && Number.isInteger(point.freqMhz)
    && point.freqMhz >= minFrequency
    && point.freqMhz <= maxFrequency
    && (index === 0 || (point.voltageV > points[index - 1].voltageV
      && point.freqMhz >= points[index - 1].freqMhz)))) return null;
  return points.map((point) => ({ voltageV: point.voltageV, freqMhz: point.freqMhz }));
}

/**
 * Return an editable copy only when the driver/profile table is already valid.
 * Never reorder, round, repair, seed, or downsample input: the array index is
 * the IGCL point identity, and the editor must submit that exact table.
 */
export function normalizeVfCurvePoints(
  points: VfCurvePoint[] | null | undefined,
  range: VfCurveRange,
  requestedMax: number = VF_EDITOR_MAX_POINTS,
): VfCurvePoint[] {
  // requestedMax is retained for source compatibility with the compact UI;
  // a real driver-owned point table takes precedence over the display limit.
  void requestedMax;
  if (isValidNativeVfCurve(points, range)) {
    return points.map((point) => ({ voltageV: point.voltageV, freqMhz: point.freqMhz }));
  }
  return [];
}

/**
 * Validate a driver-owned native STOCK/LIVE table without changing its
 * representation. The renderer uses this for reset sources, where sorting,
 * deduplicating, repairing, or compacting the points would change the native
 * write shape and can make a reset fail on Battlemage.
 */
export function isValidNativeVfCurve(
  points: VfCurvePoint[] | null | undefined,
  range: VfCurveRange,
): points is VfCurvePoint[] {
  if (!Number.isFinite(range.voltageMinV) || !Number.isFinite(range.voltageMaxV)
    || !Number.isFinite(range.freqMinMhz) || !Number.isFinite(range.freqMaxMhz)
    || range.voltageMinV > range.voltageMaxV || range.freqMinMhz > range.freqMaxMhz) return false;
  const maxPoints = Number.isFinite(range.maxPoints) && range.maxPoints > 0
    ? Math.floor(range.maxPoints)
    : 32;
  if (!Array.isArray(points) || points.length < VF_MIN_POINTS || points.length > maxPoints) return false;
  return points.every((point, index) => {
    if (!point || !Number.isFinite(point.voltageV) || !Number.isFinite(point.freqMhz)) return false;
    if (point.voltageV < range.voltageMinV || point.voltageV > range.voltageMaxV
      || point.freqMhz < range.freqMinMhz || point.freqMhz > range.freqMaxMhz) return false;
    if (index === 0) return true;
    const previous = points[index - 1];
    return point.voltageV > previous.voltageV && point.freqMhz >= previous.freqMhz;
  });
}

/** Move one point while keeping voltage ascending and frequency non-decreasing. */
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
  const freqMin = Math.max(range.freqMinMhz, previous ? previous.freqMhz : range.freqMinMhz);
  const freqMax = Math.min(range.freqMaxMhz, following ? following.freqMhz : range.freqMaxMhz);
  if (voltageMin > voltageMax || freqMin > freqMax) return next;
  next[index] = {
    voltageV: Number(clamp(Number.isFinite(voltageV) ? voltageV : current.voltageV, voltageMin, voltageMax).toFixed(3)),
    freqMhz: Math.round(clamp(Number.isFinite(freqMhz) ? freqMhz : current.freqMhz, freqMin, freqMax)),
  };
  return next;
}

/** Move only a point's frequency, preserving the driver's voltage grid and
 * allowing the native non-decreasing maximum-frequency plateau. */
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
  const freqMin = Math.max(range.freqMinMhz, previous ? previous.freqMhz : range.freqMinMhz);
  const freqMax = Math.min(range.freqMaxMhz, following ? following.freqMhz : range.freqMaxMhz);
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
