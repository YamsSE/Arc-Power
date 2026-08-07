// Arc Power — fan curve editor math (pure, DOM-free).
//
// The SVG editor renders a normalized 0..100 x (temp) / 0..100 y (speed)
// space; all point math (insert, move, clamp, sort, ascending-temp
// enforcement, point-count clamping, presets) lives here so it is testable
// without a DOM. Temps are rounded to whole °C, speeds to whole %.
//
// M4-B (user): the temp axis is STATIC 0..100 °C — deleting/adding/dragging
// points never changes the domain (deleting the outer point of a curve used
// to narrow the axis so the remaining points could not be dragged back to
// higher/lower temps). Only the RPM y-axis is dynamic.

export interface CurvePoint {
  t: number;
  speedPct: number;
}

export const MIN_CURVE_POINTS = 2;
export const MAX_CURVE_POINTS = 32; // ctl_fan_speed_table_t.table size
export const SPEED_MIN = 0;
export const SPEED_MAX = 100;
export const FAN_TEMP_MIN = 0;
export const FAN_TEMP_MAX = 100;
export const FAN_DOMAIN: CurveDomain = { minT: FAN_TEMP_MIN, maxT: FAN_TEMP_MAX };

export interface CurveDomain {
  minT: number;
  maxT: number;
}

function clampPct(pct: number): number {
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(pct)));
}

/** Sort ascending by temp (stable copy). */
export function sortByTemp(points: CurvePoint[]): CurvePoint[] {
  return [...points].sort((a, b) => a.t - b.t);
}

/**
 * Clamp the point count to `max` (and never below MIN_CURVE_POINTS),
 * keeping the first `max` points.
 */
export function clampPointCount(points: CurvePoint[], max: number): CurvePoint[] {
  const cap = Math.min(Math.floor(max), MAX_CURVE_POINTS);
  return points.slice(0, Math.max(MIN_CURVE_POINTS, cap));
}

/**
 * Ensure an editable curve has at least a 2-point ramp so the user can
 * always add/remove points: curves with < MIN_CURVE_POINTS points (a
 * canControl device that reports no curve, or a single point) are seeded
 * with {minT,20} -> {maxT,100} across the domain of the reported points.
 */
export function seedCurvePoints(points: CurvePoint[], max: number): CurvePoint[] {
  const clamped = clampPointCount(points, max);
  if (clamped.length >= MIN_CURVE_POINTS) return clamped;
  const d = curveDomain(clamped);
  return clampPointCount([
    { t: d.minT, speedPct: 20 },
    { t: d.maxT, speedPct: 100 },
  ], max);
}

/**
 * Enforce strictly ascending temps: duplicates are bumped forward by 1 °C so
 * a curve never has two points at the same temperature (IGCL requires an
 * ascending table).
 */
export function enforceAscending(points: CurvePoint[]): CurvePoint[] {
  const out = sortByTemp(points).map((p) => ({ ...p }));
  for (let i = 1; i < out.length; i++) {
    if (out[i].t <= out[i - 1].t) out[i] = { ...out[i], t: out[i - 1].t + 1 };
  }
  return out;
}

/**
 * Clamp a candidate temp for point `idx` so it stays strictly between its
 * neighbors: (prev.t + 1, next.t - 1). Returns a whole number.
 */
export function clampTempBetween(points: CurvePoint[], idx: number, t: number): number {
  const prev = idx > 0 ? points[idx - 1].t : -Infinity;
  const next = idx < points.length - 1 ? points[idx + 1].t : Infinity;
  const lo = prev === -Infinity ? -Infinity : prev + 1;
  const hi = next === Infinity ? Infinity : next - 1;
  return Math.round(Math.min(Math.max(t, lo), hi));
}

/** Move point `idx` to (t, speedPct), clamped to the legal space. */
export function movePoint(points: CurvePoint[], idx: number, t: number, speedPct: number): CurvePoint[] {
  const next = points.map((p) => ({ ...p }));
  next[idx] = { t: clampTempBetween(points, idx, t), speedPct: clampPct(speedPct) };
  return next;
}

/**
 * Add a point at (t, speedPct). Returns null when the curve is already at
 * `max` points. The inserted temp is clamped between its neighbors; after
 * insertion the curve is re-sorted and duplicates bumped.
 */
export function addPoint(points: CurvePoint[], t: number, speedPct: number, max: number): CurvePoint[] | null {
  const cap = Math.min(Math.floor(max), MAX_CURVE_POINTS);
  if (points.length >= cap) return null;
  return enforceAscending([...points, { t: Math.round(t), speedPct: clampPct(speedPct) }]);
}

/** Remove point `idx`; never below MIN_CURVE_POINTS (no-op when at minimum). */
export function removePoint(points: CurvePoint[], idx: number): CurvePoint[] {
  if (points.length <= MIN_CURVE_POINTS) return points.map((p) => ({ ...p }));
  return points.filter((_, i) => i !== idx);
}

/**
 * Insert a point at the midpoint of the widest temp gap. Returns null when
 * the curve is at `max` points or every gap is narrower than 2 °C.
 */
export function addPointAtMidGap(points: CurvePoint[], max: number): CurvePoint[] | null {
  const cap = Math.min(Math.floor(max), MAX_CURVE_POINTS);
  if (points.length >= cap) return null;
  const sorted = sortByTemp(points);
  let best = -1;
  let bestGap = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].t - sorted[i - 1].t;
    if (gap > bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  if (bestGap < 2) return null;
  const t = Math.round((sorted[best - 1].t + sorted[best].t) / 2);
  const speedPct = Math.round((sorted[best - 1].speedPct + sorted[best].speedPct) / 2);
  return enforceAscending([...sorted, { t, speedPct: clampPct(speedPct) }]);
}

/**
 * The temp domain of the fan editor: STATIC 0..100 °C (M4-B, user
 * requirement). Deleting/adding/dragging points NEVER changes the domain —
 * the whole axis always spans FAN_DOMAIN so a point removed from one end
 * can still be dragged to 0 °C / 100 °C. (The `points` argument is kept for
 * call-site compatibility; it is intentionally unused.)
 */
export function curveDomain(_points: CurvePoint[]): CurveDomain {
  return { ...FAN_DOMAIN };
}

/** Normalized editor x (0..100) for a temp in the domain. */
export function tempToX(t: number, d: CurveDomain): number {
  const span = d.maxT - d.minT;
  if (span <= 0) return 50;
  return Math.min(100, Math.max(0, ((t - d.minT) / span) * 100));
}

/** Temp for a normalized editor x (0..100). */
export function xToTemp(x: number, d: CurveDomain): number {
  return d.minT + (Math.min(100, Math.max(0, x)) / 100) * (d.maxT - d.minT);
}

/**
 * Normalized editor y (0..100, top-down SVG) for an RPM value. The marker
 * sits on the curve at the current temp/RPM; y is inverted because SVG y
 * grows downward.
 */
export function rpmMarkerY(rpm: number, maxRpm: number): number {
  if (maxRpm <= 0 || rpm <= 0) return 100;
  return 100 - Math.min(100, (rpm / maxRpm) * 100);
}

// M2C-B B1 — right-side 0-100% fan axis (mirror of the bottom temp axis).
// The axis labels live OUTSIDE the plot (the labels used to sit inside the
// SVG at x:99/x:1); each tick aligns with the horizontal grid line at the
// same normalized y (0 = top, 100 = bottom).

/** The speed-percent ticks drawn on the right-side axis. */
export const FAN_AXIS_TICKS = [0, 25, 50, 75, 100];

export interface FanAxisTick {
  pct: number;
  /** Normalized top-down y (0..100) — the grid line the tick aligns to. */
  y: number;
}

/**
 * The 0-100% scale as (pct, y) ticks, TOP-DOWN render order: 100% first
 * (top, y 0), 0% last (bottom, y 100), one tick per horizontal grid line.
 */
export function fanSpeedTicks(): FanAxisTick[] {
  return [...FAN_AXIS_TICKS].reverse().map((pct) => ({ pct, y: 100 - pct }));
}

export interface CurvePreset {
  id: string;
  name: string;
  points: CurvePoint[];
}

/**
 * Fan curve presets: straight-line ramps across the current domain,
 * `numPoints` points each (point count clamped to the device maximum).
 */
export function fanCurvePresets(d: CurveDomain, numPoints: number): CurvePreset[] {
  const n = Math.max(MIN_CURVE_POINTS, Math.min(Math.floor(numPoints), MAX_CURVE_POINTS));
  const line = (from: CurvePoint, to: CurvePoint): CurvePoint[] => {
    const pts: CurvePoint[] = [];
    for (let i = 0; i < n; i++) {
      const f = n === 1 ? 0 : i / (n - 1);
      pts.push({
        t: Math.round(from.t + (to.t - from.t) * f),
        speedPct: clampPct(from.speedPct + (to.speedPct - from.speedPct) * f),
      });
    }
    return enforceAscending(pts);
  };
  return [
    { id: 'stock', name: 'Stock', points: line({ t: d.minT, speedPct: 20 }, { t: d.maxT, speedPct: 100 }) },
    { id: 'quiet', name: 'Quiet', points: line({ t: d.minT, speedPct: 20 }, { t: d.maxT, speedPct: 55 }) },
    { id: 'max', name: 'Max cooling', points: line({ t: d.minT, speedPct: 30 }, { t: d.maxT, speedPct: 100 }) },
  ];
}
