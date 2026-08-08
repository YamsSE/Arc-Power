// Arc Power - preset computation (pure, DOM-free).
//
// Preset chips are derived from the device's capability range at runtime -
// never hardcoded. 'stock' = the capability default, 'medium' = 45% of the
// way from stock toward max, 'max' = the range max. All snapped to step and
// clamped so a chip value is always a legal apply value.

import type { RangeInfo } from '../types.ts';
import { snapToRange } from './slider.ts';

export interface Preset {
  id: 'stock' | 'medium' | 'max';
  name: string;
  value: number;
}

export function computePresets(range: RangeInfo): Preset[] {
  const stock = snapToRange(range.default, range);
  const max = snapToRange(range.max, range);
  const spread = Math.max(0, max - stock);
  const medium = snapToRange(stock + spread * 0.45, range);
  const out: Preset[] = [
    { id: 'stock', name: 'Stock', value: stock },
    { id: 'medium', name: 'Medium', value: medium },
    { id: 'max', name: 'Max', value: max },
  ];
  // Dedupe chips that collapse onto the same value on narrow ranges.
  const seen = new Set<number>();
  return out.filter((p) => (seen.has(p.value) ? false : (seen.add(p.value), true)));
}
