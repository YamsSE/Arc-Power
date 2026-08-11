// Arc Power - absolute-clock conversion (pure, DOM-free). M4-B: the
// GPU-frequency-offset card's Offset/Clock toggle (Wattman-style). The IGCL
// API only accepts OFFSETS, so Clock mode converts target clock -> offset
// before applying; every readout (slider, Driver line, chip context) shows
// the ABSOLUTE clock (base + offset) in Clock mode.
//
// baseClock = the device's default max clock (device.graphicsClockMHz - the
// same value the Dashboard device card shows), captured at render and stable
// per session. Offsets stay the stored/applied value in BOTH modes - only
// the presentation + slider range translate.
//
// M14: the IGS "Performance Boost" helpers - the boost slider is a PERCENT
// presentation of the POSITIVE offset caps max (the A770: 100% = +300 MHz
// over the 2400 MHz reference, probe-recorded in live-perf-boost.md). The
// stored/applied value stays the OFFSET in boost mode too; baseClock is
// NOT involved (the percent is relative to the offset range, never the
// absolute clock).

import type { RangeInfo } from '../types.ts';

/**
 * An absolute target clock -> the offset the IGCL API accepts. Rounded at
 * step 1 MHz (offsets snap at 1 MHz; base is integral, so the difference
 * is already integral - the round is a float-drift guard).
 */
export function clockToOffset(targetClock: number, baseClock: number): number {
  return Math.round(targetClock - baseClock);
}

/** An offset -> the absolute clock (base + offset). */
export function offsetToClock(offset: number, baseClock: number): number {
  return offset + baseClock;
}

/**
 * The offset range translated by baseClock - the slider range the Clock
 * mode exposes (e.g. A770: offset -300..300 @ base 2100 -> 1800..2400 MHz).
 * Bounds translated 1:1; the offset range's min/default/max all shift by
 * baseClock, so a snapped slider clock always maps back to an in-range
 * offset via clockToOffset.
 */
export function clockRangeFromOffsetRange(range: RangeInfo, baseClock: number): RangeInfo {
  return {
    ...range,
    min: range.min + baseClock,
    max: range.max + baseClock,
    default: range.default + baseClock,
  };
}

/**
 * M14: the boost percent -> the offset (MHz). The percent is clamped to
 * 0..100 (the slider range; a defensive clamp keeps garbage out) and
 * rounded at step 1 MHz (offsets snap at 1 MHz): 0 -> 0, 100 -> maxOffset,
 * 50 -> round(maxOffset / 2). maxOffset <= 0 degrades honestly to null
 * (no positive range -> no boost percent).
 */
export function boostToOffset(pct: number, maxOffset: number): number | null {
  if (!(maxOffset > 0)) return null;
  const p = Math.min(100, Math.max(0, pct));
  return Math.round((p / 100) * maxOffset);
}

/**
 * M14: an offset (MHz) -> the boost percent (the "Driver:" readout - the
 * clamped 0..100 %). The NEGATIVE half-plane (the mock featureset min
 * -300 vs the real driver min 0) clamps to 0 % - never a negative %.
 * maxOffset <= 0 degrades honestly to null.
 */
export function offsetToBoost(offset: number, maxOffset: number): number | null {
  if (!(maxOffset > 0)) return null;
  return Math.min(100, Math.max(0, Math.round((offset / maxOffset) * 100)));
}

/** M14: whether a device exposes a positive offset max (the Performance
 *  Boost toggle's render gate - independent of baseClock). No featureset
 *  has a zero max, so the zero-max case lives in the pure tests - the DOM
 *  rule's decision is this function. */
export function boostAvailable(maxOffset: number | null | undefined): boolean {
  return typeof maxOffset === 'number' && Number.isFinite(maxOffset) && maxOffset > 0;
}
