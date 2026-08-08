// Arc Power - rolling-graph series math (pure, DOM-free).
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
 * M4-D2 fix (user: "the monitoring graphs are glitched - the lines
 * overlap"): the REAL driver's telemetry timestamp occasionally ticks
 * BACKWARD (live-verified: 8 folds in 40 s under load on the A770 - a
 * counter-readout race in the driver). A non-monotonic t folds the drawn
 * polyline back over itself ("overlapping lines"). Sort by t so the drawn
 * line is ALWAYS the true chronological timeline - never a fold. Sorting
 * is stable and cheap (≤ GRAPH_MAX_POINTS points).
 * @param series the series (possibly out of time order)
 * @returns a NEW series sorted by t
 */
export function sortSeriesByTime(series: SeriesPoint[]): SeriesPoint[] {
  if (series.length <= 1) return series;
  return [...series].sort((a, b) => a.t - b.t);
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

/**
 * M4-C: the index of the series point nearest to a normalized x position
 * (0..1 across the DRAWN window: points[0].t .. points[last].t - the same
 * linear mapping the canvas uses). The Monitoring hover feeds it the pointer
 * x so the crosshair + popup snap to the nearest sample on the line.
 * Returns -1 for an empty series. `xNorm` is clamped to [0, 1] (hovering
 * outside the plot snaps to the nearest edge sample); between-sample
 * positions round to the CLOSEST point by time, ties keeping the earlier
 * sample. Series times are ascending (telemetry push order).
 */
export function nearestSampleIndex(points: SeriesPoint[], xNorm: number): number {
  if (points.length === 0) return -1;
  const n = points.length;
  const x = Math.min(1, Math.max(0, xNorm));
  const tMin = points[0].t;
  const tMax = points[n - 1].t;
  const target = tMin + x * (tMax - tMin);
  let best = 0;
  let bestDist = Math.abs(points[0].t - target);
  for (let i = 1; i < n; i++) {
    const d = Math.abs(points[i].t - target);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}
