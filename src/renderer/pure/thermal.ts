// Shared thermal semantics so temperatures read the same on every page.
// Thresholds are advisory bands (ok / warm / hot / critical); they never gate
// an apply - the device limits still come from the driver.

export type ThermalSeverity = 'ok' | 'warm' | 'hot' | 'critical';
export type ThermalKind = 'cpu' | 'gpu' | 'vram';

interface ThermalBands {
  warm: number;
  hot: number;
  critical: number;
}

export const THERMAL_BANDS: Record<ThermalKind, ThermalBands> = {
  cpu: { warm: 75, hot: 90, critical: 100 },
  gpu: { warm: 70, hot: 83, critical: 95 },
  vram: { warm: 80, hot: 90, critical: 100 },
};

export function temperatureSeverity(celsius: number | null | undefined, kind: ThermalKind = 'gpu'): ThermalSeverity | null {
  if (typeof celsius !== 'number' || !Number.isFinite(celsius)) return null;
  const bands = THERMAL_BANDS[kind];
  if (celsius >= bands.critical) return 'critical';
  if (celsius >= bands.hot) return 'hot';
  if (celsius >= bands.warm) return 'warm';
  return 'ok';
}
