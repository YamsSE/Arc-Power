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

export type VfCurveEditorSource = 'live' | 'stock-reference' | 'unavailable';

export interface VfCurveEditorSelection {
  source: VfCurveEditorSource;
  points: VfCurvePoint[];
}

export const VF_EDITOR_MAX_POINTS = 10;
export const VF_MIN_POINTS = 2;

/** A saved reference may move only by a common voltage translation. */
export function matchesVfCurveReference(saved: VfCurvePoint[], fresh: VfCurvePoint[]): boolean {
  if (!Array.isArray(saved) || !Array.isArray(fresh) || saved.length < 2 || saved.length !== fresh.length) return false;
  const shift = fresh[0]?.voltageV - saved[0]?.voltageV;
  return Number.isFinite(shift) && saved.every((point, index) => {
    const other = fresh[index];
    return Number.isFinite(point?.voltageV) && Number.isFinite(point?.freqMhz)
      && Number.isFinite(other?.voltageV) && point.freqMhz === other?.freqMhz
      && (index === 0 || (point.voltageV > saved[index - 1].voltageV
        && point.freqMhz >= saved[index - 1].freqMhz))
      && Math.abs(other.voltageV - point.voltageV - shift) <= 1e-9;
  });
}

/** Preserve each point's explicit edit while resolving the driver's current origin. */
export function rebaseVfCurveToReference(requested: VfCurvePoint[], saved: VfCurvePoint[], fresh: VfCurvePoint[], range: VfCurveRange): VfCurvePoint[] | null {
  if (!matchesVfCurveReference(saved, fresh) || !Array.isArray(requested) || requested.length !== saved.length) return null;
  return prepareVfCurveForDriver(requested.map((point, index) => ({
    voltageV: Number((fresh[index].voltageV + point.voltageV - saved[index].voltageV).toFixed(9)),
    freqMhz: point.freqMhz,
  })), range);
}

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

function stepForRange(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? value as number : fallback;
}

function snapToGridWithin(value: number, min: number, max: number, origin: number, step: number): number | null {
  if (min > max || !Number.isFinite(step) || step <= 0) return null;
  const epsilon = 1e-9;
  const minIndex = Math.ceil((min - origin) / step - epsilon);
  const maxIndex = Math.floor((max - origin) / step + epsilon);
  if (minIndex > maxIndex) return null;
  const requestedIndex = Math.round(((Number.isFinite(value) ? value : min) - origin) / step);
  const index = Math.min(maxIndex, Math.max(minIndex, requestedIndex));
  const snapped = origin + index * step;
  return Number(snapped.toFixed(6));
}

function isOnGrid(value: number, origin: number, step: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(origin) || !Number.isFinite(step) || step <= 0) return false;
  const gridPosition = (value - origin) / step;
  return Math.abs(gridPosition - Math.round(gridPosition)) <= 1e-7;
}

function legalMaxPoints(range: VfCurveRange, requested: number): number {
  const driverMax = Number.isFinite(range.maxPoints) && range.maxPoints > 0
    ? Math.floor(range.maxPoints)
    : VF_EDITOR_MAX_POINTS;
  return Math.max(VF_MIN_POINTS, Math.min(VF_EDITOR_MAX_POINTS, driverMax, Math.floor(requested)));
}

/**
 * Convert a valid curve into the integer-MHz shape accepted by the native
 * custom-curve writer. The editor uses IGS's 1MHz point precision; the driver
 * may normalize a requested frequency to its reported native step, which is
 * verified from stable LIVE read-back after the single write. IGCL exposes equal adjacent frequencies in STOCK and
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
    && isOnGrid(point.voltageV, range.voltageMinV, stepForRange(range.voltageStepV, 0.001))
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

/**
 * Select the curve to show when opening the editor. A verified LIVE table is
 * authoritative; if LIVE is temporarily unreadable, a verified STOCK table
 * remains useful as a clearly labelled reference. Never repair either table.
 */
export function selectVfCurveEditorCurve(
  live: VfCurvePoint[] | null | undefined,
  stock: VfCurvePoint[] | null | undefined,
  range: VfCurveRange,
): VfCurveEditorSelection {
  const liveValid = isValidNativeVfCurve(live, range);
  const stockValid = isValidNativeVfCurve(stock, range);
  const points = liveValid ? live : stockValid ? stock : [];
  return {
    source: liveValid ? 'live' : stockValid ? 'stock-reference' : 'unavailable',
    points: points.map((point) => ({ voltageV: point.voltageV, freqMhz: point.freqMhz })),
  };
}

/** Keep an async driver refresh from replacing a draft or another device's
 * editor after the request has started. */
export function shouldCommitVfCurveRefresh(
  requestedDeviceId: number,
  currentDeviceId: number | null,
  requestedDeviceKey: string | null,
  currentDeviceKey: string | null,
  hasPendingDraft: boolean,
  requestGeneration: number,
  currentGeneration: number,
): boolean {
  return currentDeviceId === requestedDeviceId
    && currentDeviceKey === requestedDeviceKey
    && !hasPendingDraft
    && requestGeneration === currentGeneration;
}

const VF_EDITOR_FREQUENCY_STEP_MHZ = 1;

function copyPoints(points: VfCurvePoint[]): VfCurvePoint[] {
  return points.map((point) => ({ ...point }));
}

/**
 * IGS moves neighboring graph points when an edit would break curve ordering.
 * X is kept strictly ascending with one UI step between points; Y is kept
 * non-decreasing by extending a plateau forward or backward from the edit.
 */
function propagateVfPointEdit(
  points: VfCurvePoint[],
  index: number,
  voltageV: number,
  freqMhz: number,
  range: VfCurveRange,
): VfCurvePoint[] {
  const unchanged = copyPoints(points);
  if (!Array.isArray(points) || index < 0 || index >= points.length
    || !Number.isFinite(voltageV) || !Number.isFinite(freqMhz)
    || !Number.isFinite(range.voltageMinV) || !Number.isFinite(range.voltageMaxV)
    || !Number.isFinite(range.freqMinMhz) || !Number.isFinite(range.freqMaxMhz)
    || range.voltageMinV > range.voltageMaxV || range.freqMinMhz > range.freqMaxMhz
    || points.length < VF_MIN_POINTS) return unchanged;

  const voltageMin = range.voltageMinV;
  const voltageMax = range.voltageMaxV;
  const frequencyMin = range.freqMinMhz;
  const frequencyMax = range.freqMaxMhz;
  const voltageStep = stepForRange(range.voltageStepV, 0.001);
  const frequencyStep = VF_EDITOR_FREQUENCY_STEP_MHZ;
  if (!points.every((point, pointIndex) => point
    && Number.isFinite(point.voltageV) && Number.isFinite(point.freqMhz)
    && point.voltageV >= voltageMin && point.voltageV <= voltageMax
    && point.freqMhz >= frequencyMin && point.freqMhz <= frequencyMax
    && (pointIndex === 0 || (point.voltageV > points[pointIndex - 1].voltageV
      && point.freqMhz >= points[pointIndex - 1].freqMhz)))) return unchanged;
  const minEditedVoltage = voltageMin + index * voltageStep;
  const maxEditedVoltage = voltageMax - (points.length - 1 - index) * voltageStep;
  if (minEditedVoltage > maxEditedVoltage) return unchanged;

  const next = copyPoints(points);
  // Keep voltage on the adapter's reported grid and frequency on IGS's
  // 1MHz UI increments. X spacing may move neighbors, just as the IGS graph does.
  const snappedVoltage = snapToGridWithin(
    voltageV, minEditedVoltage, maxEditedVoltage, voltageMin, voltageStep,
  );
  const snappedFrequency = snapToGridWithin(
    freqMhz, frequencyMin, frequencyMax, frequencyMin, frequencyStep,
  );
  if (snappedVoltage === null || snappedFrequency === null) return unchanged;
  next[index] = { voltageV: snappedVoltage, freqMhz: snappedFrequency };

  for (let pointIndex = index + 1; pointIndex < next.length; pointIndex += 1) {
    const minPointVoltage = next[pointIndex - 1].voltageV + voltageStep;
    const maxPointVoltage = voltageMax - (next.length - 1 - pointIndex) * voltageStep;
    const snapped = snapToGridWithin(
      next[pointIndex].voltageV, minPointVoltage, maxPointVoltage, voltageMin, voltageStep,
    );
    if (snapped === null) return unchanged;
    next[pointIndex].voltageV = snapped;
    if (next[pointIndex].freqMhz < next[pointIndex - 1].freqMhz) {
      next[pointIndex].freqMhz = next[pointIndex - 1].freqMhz;
    }
  }

  for (let pointIndex = index - 1; pointIndex >= 0; pointIndex -= 1) {
    const minPointVoltage = voltageMin + pointIndex * voltageStep;
    const maxPointVoltage = next[pointIndex + 1].voltageV - voltageStep;
    const snapped = snapToGridWithin(
      next[pointIndex].voltageV, minPointVoltage, maxPointVoltage, voltageMin, voltageStep,
    );
    if (snapped === null) return unchanged;
    next[pointIndex].voltageV = snapped;
    if (next[pointIndex].freqMhz > next[pointIndex + 1].freqMhz) {
      next[pointIndex].freqMhz = next[pointIndex + 1].freqMhz;
    }
  }

  if (next.some((point, pointIndex) => point.freqMhz < frequencyMin || point.freqMhz > frequencyMax
    || (pointIndex > 0 && (point.voltageV <= next[pointIndex - 1].voltageV
      || point.freqMhz < next[pointIndex - 1].freqMhz)))) return unchanged;
  return next;
}

/** Move one point using the IGS neighboring-point propagation behavior. */
export function moveVfPoint(
  points: VfCurvePoint[],
  index: number,
  voltageV: number,
  freqMhz: number,
  range: VfCurveRange,
  linkTerminalPlateau = false,
): VfCurvePoint[] {
  const next = propagateVfPointEdit(points, index, voltageV, freqMhz, range);
  if (!linkTerminalPlateau || index < points.length - 2 || index >= points.length
    || next[index]?.freqMhz === points[index]?.freqMhz) return next;
  const partner = index === points.length - 1 ? index - 1 : index + 1;
  return propagateVfPointEdit(next, partner, next[partner].voltageV, next[index].freqMhz, range);
}

/** Only the native Battlemage STOCK ending plateau defines linked frequency points. */
export function hasLinkedVfTerminalPlateau(
  stock: VfCurvePoint[] | null | undefined,
  range: VfCurveRange,
  battlemage: boolean,
): boolean {
  return battlemage && isValidNativeVfCurve(stock, range)
    && stock[stock.length - 2].freqMhz === stock[stock.length - 1].freqMhz;
}

/** Move only a point's frequency, preserving the driver's voltage grid and
 * allowing the native non-decreasing maximum-frequency plateau. */
export function moveVfFrequencyPoint(
  points: VfCurvePoint[],
  index: number,
  freqMhz: number,
  range: VfCurveRange,
): VfCurvePoint[] {
  if (index < 0 || index >= points.length) return copyPoints(points);
  return propagateVfPointEdit(points, index, points[index].voltageV, freqMhz, range);
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
