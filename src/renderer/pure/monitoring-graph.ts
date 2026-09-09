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

/**
 * Return the fixed-bottom, metric-aware range used by Monitoring canvases.
 * Utilization is a percentage, so its meaningful domain is always 0..100.
 * Other metrics use zero as their floor and the largest finite sample as
 * their ceiling. A zero-only (or otherwise non-positive) series gets a
 * small positive ceiling so the line still has a drawable scale.
 */
export function monitoringGraphRange(seriesId: string, points: SeriesPoint[]): GraphRange | null {
  if (points.length === 0) return null;
  let max = -Infinity;
  for (const point of points) {
    if (Number.isFinite(point.v) && point.v > max) max = point.v;
  }
  if (!Number.isFinite(max)) return null;
  const segment = monitoringGraphSegment(seriesId);
  if (segment === 'util' || segment === 'cpu-util') return { min: 0, max: 100 };
  return { min: 0, max: max > 0 ? max : 1 };
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
