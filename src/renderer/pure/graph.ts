// Arc Power — rolling-graph series math (pure, DOM-free).
//
// The Monitoring page keeps one series per segment (clock/temp/power/util/
// fan) fed by telemetry samples and draws them on a Canvas. This module
// owns the series bookkeeping + scaling + downsampling so the drawing code
// stays thin; every function here is unit-tested.

export interface SeriesPoint {
  t: number;
  v: number;
}

/** Default rolling window: 60 s of telemetry at the 500 ms poll cadence. */
export const GRAPH_WINDOW_S = 60;
export const GRAPH_MAX_POINTS = 240;

/**
 * Append a sample to a series (immutable: returns a new array). Absent or
 * non-finite values are dropped (a gap is drawn as a break, not a zero).
 * The series is capped at `maxLen` points.
 */
export function pushSeries(series: SeriesPoint[], t: number, v: number | undefined, maxLen: number = GRAPH_MAX_POINTS): SeriesPoint[] {
  if (v === undefined || !Number.isFinite(v)) return series;
  const next = [...series, { t, v }];
  if (next.length > maxLen) next.splice(0, next.length - maxLen);
  return next;
}

/**
 * Drop points older than `now - windowS` (the rolling window). Series grow
 * in lockstep with telemetry time, so trimming by time keeps the drawn
 * window honest even if the poll cadence drifts.
 */
export function trimSeriesWindow(series: SeriesPoint[], now: number, windowS: number = GRAPH_WINDOW_S): SeriesPoint[] {
  const cutoff = now - windowS;
  let first = 0;
  while (first < series.length && series[first].t < cutoff) first++;
  return first === 0 ? series : series.slice(first);
}

/**
 * Y-axis scale for a series with a 10% headroom pad on both sides. Flat
 * series get a symmetric pad (never a zero-height scale). Empty series
 * return null (the canvas draws empty).
 */
export function autoScale(points: SeriesPoint[]): { min: number; max: number } | null {
  if (points.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * 0.1;
  return { min: min - pad, max: max + pad };
}

/**
 * Evenly-spaced downsampling to at most `maxPoints` (pick the nearest index
 * per bucket). Series shorter than the cap pass through untouched; a cap of
 * < 2 keeps the first point only.
 */
export function downsample(points: SeriesPoint[], maxPoints: number): SeriesPoint[] {
  if (points.length <= maxPoints) return points;
  if (maxPoints < 2) return points.slice(0, maxPoints > 0 ? maxPoints : 0);
  const out: SeriesPoint[] = [];
  const stride = (points.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    out.push(points[Math.round(i * stride)]);
  }
  return out;
}
