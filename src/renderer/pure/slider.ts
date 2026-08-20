// Arc Power - slider math (pure, DOM-free).
//
// Sliders render capability ranges from the backend and must snap to the
// capability step on every user interaction; the driver's current value may
// be off-grid (e.g. the A770's ~48.3 MHz offset) - the slider value and the
// driver value are deliberately distinct and both shown in the UI.

import type { RangeInfo } from '../types.ts';

/**
 * Snap `value` to the nearest multiple of `range.step` from `range.min`,
 * then clamp to [min, max]. Preserves min/max exactly (a step need not
 * divide the range evenly). Non-finite input snaps to min.
 */
export function snapToRange(value: number, range: RangeInfo): number {
  const { min, max, step } = range;
  if (!Number.isFinite(value)) return min;
  if (step <= 0) return Math.min(max, Math.max(min, value));
  let snapped = min + Math.round((value - min) / step) * step;
  // Float-drift guard (0.005 steps accumulate 0.0050000..1).
  snapped = Math.round(snapped / step) * step;
  return Math.min(max, Math.max(min, snapped));
}

/**
 * Normalized 0..1 position of `value` within [min, max] - drives the
 * slider's filled-track width.
 */
export function normalizedPosition(value: number, range: RangeInfo): number {
  const { min, max } = range;
  if (!Number.isFinite(value)) return 0;
  if (max <= min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/**
 * Format a value for readouts: volts keep 3 decimals, everything else is
 * integral. Units map C -> °C; everything else passes through. `decimals`
 * overrides the default when given (used for off-grid driver readouts).
 */
export function formatValue(value: number, units: string, decimals?: number): string {
  if (!Number.isFinite(value)) return '-';
  const unit = units === 'C' ? '°C' : units;
  const d = decimals ?? (units === 'V' ? 3 : 0);
  return `${value.toFixed(d)} ${unit}`;
}

/**
 * Format the driver's current value for the card readout line. Off-grid
 * values (e.g. the A770's 48.3 MHz offset) get one extra decimal so they
 * are distinguishable from the snapped slider value.
 */
export function formatDriverValue(value: number | null | undefined, range: RangeInfo): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unavailable';
  if (range.units === 'V' && value < 0) return 'unavailable';
  const base = range.units === 'V' ? 3 : 0;
  return formatValue(value, range.units, base + (isOffGrid(value, range) ? 1 : 0));
}

/** True when the driver's current value is off the capability grid. */
export function isOffGrid(value: number | null | undefined, range: RangeInfo): boolean {
  if (value === null || value === undefined || !Number.isFinite(value)) return false;
  if (range.units === 'V' && value < 0) return false;
  return snapToRange(value, range) !== value;
}
