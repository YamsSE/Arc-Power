// Arc Power - slider math (pure, DOM-free).
//
// Sliders render capability ranges from the backend and must snap to the
// capability step on every user interaction; the driver's current value may
// be off-grid (e.g. the A770's ~48.3 MHz offset) - the slider value and the
// driver value are deliberately distinct and both shown in the UI.

import type { RangeInfo } from '../types.ts';

export interface ControlDisplay {
  units: string;
  decimals: number;
}

/**
 * User-facing tuning units. The apply range remains untouched: some
 * Battlemage drivers expose the voltage and temperature controls with a
 * percent enum even though the product surface is an offset in mV and a
 * limit in °C. This helper changes presentation only, never the numeric
 * payload sent through settings.
 */
export function controlDisplay(key: string, range: RangeInfo, deviceName = ''): ControlDisplay {
  const battlemage = /battlemage|\bB\d{2,4}\b/i.test(deviceName);
  if (battlemage && key === 'gpuVoltOffsetV' && range.units === '%') {
    return { units: 'mV', decimals: 0 };
  }
  if (battlemage && key === 'tempLimitC' && range.units === '%') {
    return { units: 'C', decimals: 0 };
  }
  // Battlemage VRAM speed ranges are absolute MHz after the backend's unit
  // conversion. Their capability step may still be fractional (0.125), but
  // the requested product readout is a whole MHz value.
  if (key === 'vramFreqOffsetGts' && range.units === 'MHz') {
    return { units: 'MHz', decimals: 0 };
  }
  return { units: range.units, decimals: range.units === 'V' ? 3 : 0 };
}

export function formatControlValue(value: number, key: string, range: RangeInfo, deviceName = ''): string {
  const display = controlDisplay(key, range, deviceName);
  return formatValue(value, display.units, display.decimals);
}

export function formatControlDriverValue(value: number | null | undefined, key: string, range: RangeInfo, deviceName = ''): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unavailable';
  const display = controlDisplay(key, range, deviceName);
  // A displayed mV/°C value is not in the raw range's unit vocabulary, and
  // VRAM MHz intentionally suppresses off-grid precision in the readout.
  if (display.units !== range.units || (key === 'vramFreqOffsetGts' && range.units === 'MHz')) {
    return formatValue(value, display.units, display.decimals);
  }
  return formatDriverValue(value, range);
}

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
