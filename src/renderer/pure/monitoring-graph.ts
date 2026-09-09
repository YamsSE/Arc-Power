// Arc Power - pure geometry/formatting helpers for Monitoring graph overlays.
// Keeping these calculations DOM-free makes the hover and edge-clamp contract
// testable without relying on a particular browser layout engine.

import { downsample } from './graph.ts';
import type { SeriesPoint } from './graph.ts';

/** Maximum number of points painted into a compact Monitoring sparkline. */
export const MONITORING_GRAPH_MAX_POINTS = 72;

export interface GraphRange {
  min: number;
  max: number;
}

const MONITORING_GRAPH_DEFAULT_CEILINGS: Readonly<Record<string, number>> = {
  util: 100,
  'cpu-util': 100,
  temp: 100,
  'vram-temp': 100,
  'cpu-temp': 100,
  'cpu-clock': 5000,
  clock: 3500,
  'mem-clock': 3500,
  fan: 5000,
  voltage: 2,
  power: 400,
  'cpu-power': 400,
};

/**
 * Return the fixed-bottom, metric-aware range used by Monitoring canvases.
 * Utilization is a percentage, so its meaningful domain is always 0..100.
 * Other metrics use zero as their floor and a metric-specific ceiling; the
 * optional context ceiling carries physical capacities or a session
 * high-water mark, and the result expands to the largest finite sample when
 * hardware reports above it. A zero-only (or otherwise non-positive) series
 * still gets a positive ceiling so the line has a drawable scale.
 */
export function monitoringGraphRangeForMax(seriesId: string, observedMax: number | null | undefined, ceiling?: number | null): GraphRange | null {
  if (!Number.isFinite(observedMax)) return null;
  const segment = monitoringGraphSegment(seriesId);
  const defaultCeiling = MONITORING_GRAPH_DEFAULT_CEILINGS[segment] ?? null;
  const suppliedCeiling = Number.isFinite(ceiling) && Number(ceiling) > 0 ? Number(ceiling) : null;
  // A physical capacity or session high-water mark can extend a default,
  // but must never replace it. Otherwise a low first sample (for example
  // 3% utilization) would incorrectly collapse the axis to 0..3.
  return { min: 0, max: Math.max(1, defaultCeiling ?? 0, suppliedCeiling ?? 0, Number(observedMax)) };
}

/**
 * Compute the same axis from a series when its observed maximum is not yet
 * available. The renderer normally scans the series once for its observed
 * Min/Max row, then calls monitoringGraphRangeForMax to avoid a second scan.
 */
export function monitoringGraphRange(seriesId: string, points: SeriesPoint[], ceiling?: number | null): GraphRange | null {
  if (points.length === 0) return null;
  let max = -Infinity;
  for (const point of points) {
    if (Number.isFinite(point.v) && point.v > max) max = point.v;
  }
  return monitoringGraphRangeForMax(seriesId, max, ceiling);
}

export interface GraphSamplePosition {
  x: number;
  y: number;
}

export interface GraphTooltipPosition {
  left: number;
  top: number;
}

/**
 * Return the exact point set painted by a Monitoring graph. Keeping this
 * helper beside the hover geometry prevents the Canvas and overlay from
 * silently adopting different downsampling rules.
 */
export function graphDrawnPoints(points: SeriesPoint[]): SeriesPoint[] {
  return downsample(points, MONITORING_GRAPH_MAX_POINTS);
}

/** Normalize a graph id to the metric segment used by display formatting. */
export function monitoringGraphSegment(seriesId: string): string {
  if (seriesId.startsWith('gpu:')) return seriesId.slice(seriesId.lastIndexOf(':') + 1);
  if (seriesId.startsWith('system-')) return seriesId.slice('system-'.length);
  if (seriesId.startsWith('fps-')) return seriesId.slice('fps-'.length);
  return seriesId.replace(/^gpu-\d+-/, '');
}

/** Unitless compact Y-axis/range/hover formatting for a graph metric. */
export function formatMonitoringGraphValue(seriesId: string, value: number): string {
  const segment = monitoringGraphSegment(seriesId);
  if (segment === 'power' || segment === 'cpu-power' || segment === 'vram' || segment === 'ram-used' || segment === 'ram-capacity') return value.toFixed(1);
  if (segment === 'voltage') return value.toFixed(3);
  if (segment === 'frame-time') return value.toFixed(1);
  return String(Math.round(value));
}

/** Compact unitless elapsed time for the Afterburner-style X readout. */
export function graphAxisTime(points: SeriesPoint[], index: number): string {
  if (points.length === 0 || index < 0 || index >= points.length) return '—';
  const start = points[0].t;
  const elapsed = Math.max(0, points[index].t - start);
  return elapsed >= 10 ? elapsed.toFixed(0) : elapsed.toFixed(1);
}

/**
 * Position a nearest sample using the same 2 px endpoint margins and lower
 * 13 px X-label strip as the Canvas renderer.
 */
export function graphSamplePosition(
  points: SeriesPoint[],
  index: number,
  width: number,
  height: number,
  range: GraphRange,
): GraphSamplePosition | null {
  if (points.length === 0 || index < 0 || index >= points.length || width <= 0 || height <= 0) return null;
  const timeSpan = Math.max(0.001, points[points.length - 1].t - points[0].t);
  const ratio = Math.min(1, Math.max(0, (points[index].t - points[0].t) / timeSpan));
  const valueSpan = Math.max(0.001, range.max - range.min);
  const x = points.length <= 1 ? width / 2 : ratio * (width - 4) + 2;
  const y = height - 13 - ((points[index].v - range.min) / valueSpan) * Math.max(4, height - 18);
  return { x, y };
}

/**
 * Place the compact hover readout at the top of the graph, next to the
 * vertical crosshair. Keep it on the right for a left-side crosshair and on
 * the left for a right-side crosshair so the text remains easy to read.
 */
export function clampGraphTooltipPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  textWidth: number,
  textHeight: number,
): GraphTooltipPosition {
  // The Y coordinate is intentionally independent of the sample value. The
  // graph's top edge is a stable, uncluttered home for the hover readout.
  const gap = 5;
  const maxLeft = Math.max(1, width - Math.max(0, textWidth) - 1);
  const desiredLeft = x <= width / 2
    ? x + gap
    : x - Math.max(0, textWidth) - gap;
  const left = Math.min(Math.max(1, desiredLeft), maxLeft);
  const maxTop = Math.max(1, height - Math.max(0, textHeight) - 1);
  const top = Math.min(2, maxTop);
  return { left, top };
}
