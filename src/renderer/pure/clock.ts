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
