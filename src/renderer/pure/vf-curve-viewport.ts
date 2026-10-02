import { isValidNativeVfCurve } from './vf-curve.ts';
import type { VfCurvePoint } from './vf-curve.ts';
import type { VfCurveRange } from '../types.ts';

/** Auto-pan with the accepted LIVE first point. STOCK has an independent origin.
 * Draft edits keep this domain frozen. Native values and axis labels stay exact;
 * a uniform accepted translation moves the ticks, while preserving dot positions.
 * Frequencies may change during Apply, so they do not define the display origin. */
export function vfCurveVoltageViewport(anchor: VfCurvePoint[] | null, live: VfCurvePoint[] | null,
  range: VfCurveRange, battlemage: boolean): { voltageMinV: number; voltageMaxV: number } {
  const shift = battlemage && isValidNativeVfCurve(anchor, range) && isValidNativeVfCurve(live, range)
    ? live[0].voltageV - anchor[0].voltageV : 0;
  return { voltageMinV: range.voltageMinV + shift, voltageMaxV: range.voltageMaxV + shift };
}
