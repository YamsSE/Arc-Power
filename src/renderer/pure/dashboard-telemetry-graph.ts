// Shared sample geometry for the four Dashboard telemetry sparklines.
// Samples can omit individual metrics, so every metric must keep its position
// on the lane's complete sample axis instead of compressing missing values.

export interface DashboardTelemetryPoint {
  t: number;
  value: number | null | undefined;
}

export interface DashboardSparklinePaths {
  line: string;
  area: string;
}

export function dashboardSparklinePaths(
  points: readonly DashboardTelemetryPoint[],
  min: number,
  max: number,
  width = 120,
  top = 4,
  bottom = 34,
): DashboardSparklinePaths {
  if (points.length === 0) return { line: `M 0 ${bottom} L ${width} ${bottom}`, area: `M 0 ${bottom} L ${width} ${bottom} Z` };

  const valueSpan = Math.max(0.001, max - min);
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let segment: Array<{ x: number; y: number }> = [];

  const flush = (): void => {
    if (segment.length) segments.push(segment);
    segment = [];
  };

  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (typeof point.value !== 'number' || !Number.isFinite(point.value)) {
      flush();
      continue;
    }
    const x = points.length <= 1 ? width / 2 : (index / (points.length - 1)) * width;
    const y = Math.max(top, Math.min(bottom, bottom - ((point.value - min) / valueSpan) * (bottom - top)));
    segment.push({ x, y });
  }
  flush();

  if (segments.length === 0) return { line: `M 0 ${bottom} L ${width} ${bottom}`, area: `M 0 ${bottom} L ${width} ${bottom} Z` };

  const line = segments.map((values) => {
    const first = values[0];
    if (values.length === 1) {
      const dotEnd = first.x >= width ? Math.max(0, first.x - 0.1) : Math.min(width, first.x + 0.1);
      return `M ${first.x.toFixed(1)} ${first.y.toFixed(1)} L ${dotEnd.toFixed(1)} ${first.y.toFixed(1)}`;
    }
    return `M ${first.x.toFixed(1)} ${first.y.toFixed(1)} L ${values.slice(1).map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' L ')}`;
  }).join(' ');

  const area = segments
    .filter((values) => values.length > 1)
    .map((values) => {
      const first = values[0];
      const last = values[values.length - 1];
      const trace = values.slice(1).map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' L ');
      return `M ${first.x.toFixed(1)} ${bottom} L ${first.x.toFixed(1)} ${first.y.toFixed(1)} L ${trace} L ${last.x.toFixed(1)} ${bottom} Z`;
    })
    .join(' ');

  return { line, area };
}

/** Return the finite sample nearest to a normalized lane-wide X position. */
export function nearestDashboardTelemetryPoint(
  points: readonly DashboardTelemetryPoint[],
  ratio: number,
): DashboardTelemetryPoint | null {
  if (points.length === 0) return null;
  const index = points.length <= 1 ? 0 : Math.round(Math.min(1, Math.max(0, ratio)) * (points.length - 1));
  for (let distance = 0; distance < points.length; distance++) {
    const before = index - distance;
    const after = index + distance;
    if (before >= 0) {
      const point = points[before];
      if (typeof point.value === 'number' && Number.isFinite(point.value)) return point;
    }
    if (distance > 0 && after < points.length) {
      const point = points[after];
      if (typeof point.value === 'number' && Number.isFinite(point.value)) return point;
    }
  }
  return null;
}
