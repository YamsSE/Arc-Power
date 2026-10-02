import { vfCurveVoltageOriginShiftMv } from './vf-curve-recovery.ts';
import type { VfCurvePoint } from './vf-curve.ts';
import type { VfCurveRange } from '../types.ts';

/** Translate only the plotting domain with a proven common STOCK origin shift.
 * Native point values and the driver's validation range remain untouched. */
export function vfCurveVoltageViewport(anchor: VfCurvePoint[] | null, stock: VfCurvePoint[] | null,
  range: VfCurveRange, battlemage: boolean): { voltageMinV: number; voltageMaxV: number } {
  const shift = vfCurveVoltageOriginShiftMv(anchor, stock, range, battlemage) ?? 0;
  return { voltageMinV: range.voltageMinV + shift / 1000, voltageMaxV: range.voltageMaxV + shift / 1000 };
}
