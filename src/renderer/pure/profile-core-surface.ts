import type { Settings } from '../types.ts';

type ProfileVfPoint = NonNullable<Settings['vfCurve']>[number];

function isValidProfileVfCurve(points: unknown): points is ProfileVfPoint[] {
  return Array.isArray(points) && points.length >= 2 && points.every((point, index) => point
    && typeof point === 'object'
    && Number.isFinite(point.voltageV) && point.voltageV > 0
    && Number.isFinite(point.freqMhz) && point.freqMhz >= 0
    && (index === 0 || (point.voltageV > points[index - 1].voltageV
      && point.freqMhz >= points[index - 1].freqMhz)));
}

/** Any finite nonzero core offset identifies the scalar tuning surface. */
export function hasScalarCoreOffsets(settings: { gpuFreqOffsetMhz?: number | null; gpuVoltOffsetV?: number | null }): boolean {
  return [settings.gpuFreqOffsetMhz, settings.gpuVoltOffsetV].some((value) =>
    typeof value === 'number' && Number.isFinite(value) && value !== 0);
}

export function omitProfileVfFields(settings: Settings): Settings {
  const out = { ...settings };
  delete out.vfCurve;
  delete out.vfCurveBaseline;
  delete out.vfCurveStockReference;
  delete out.vfCurveResetToDefault;
  return out;
}

/** An exact native STOCK capture is known not to be a custom VF table. */
export function isExactStockVfCurve(
  live: ProfileVfPoint[] | null | undefined,
  stock: ProfileVfPoint[] | null | undefined,
): boolean {
  return isValidProfileVfCurve(live) && isValidProfileVfCurve(stock)
    && live.length === stock.length
    && live.every((point, index) => point.voltageV === stock[index].voltageV
      && point.freqMhz === stock[index].freqMhz);
}

/** Repair only the old capture's exact STOCK-plus-frequency-offset signature. */
export function repairLegacyScalarProfile(settings: Settings): Settings {
  const stock = settings.vfCurveStockReference;
  const curve = settings.vfCurve;
  if (!hasScalarCoreOffsets(settings) || settings.vfCurveBaseline !== undefined
    || settings.vfCurveResetToDefault === true || !Array.isArray(stock) || stock.length < 2
    || !Array.isArray(curve) || curve.length !== stock.length) return settings;
  const offset = settings.gpuFreqOffsetMhz ?? 0;
  if (!Number.isFinite(offset) || (settings.gpuVoltOffsetV != null && !Number.isFinite(settings.gpuVoltOffsetV))) return settings;
  if (!isValidProfileVfCurve(stock) || !isValidProfileVfCurve(curve)) return settings;
  const exactScalarCurve = stock.every((point, index) => {
    const live = curve[index];
    return live.voltageV === point.voltageV && live.freqMhz === point.freqMhz + offset;
  });
  return exactScalarCurve ? omitProfileVfFields(settings) : settings;
}
