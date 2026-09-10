// Arc Power - Monitoring page (M2b-B/M168): a compact Metrics surface fed by
// the telemetry IPC push. FPS, CPU, system memory, and every physical GPU get
// their own independently collapsible readout panel; GPU history remains in
// one rolling Canvas trend per signal and per adapter with the same 60-sample
// pulse window as Dashboard (about 24 seconds at the stock 400 ms cadence).
// Trend cards start collapsed so the page stays dense on entry.
// FPS comes from the fps-poll IPC channel (the ETW/PresentMon lane first -
// the foreground program's per-frame present stream; the DXGI
// frame-statistics / output-duplication adapter as the fallback); when no
// present data is being captured the page shows "FPS unavailable"
// gracefully - never an error.
//
// M168: the former two-group readout is replaced by the Metrics panel grid;
// each panel owns its own dropdown and all fields stay bound to the matching
// physical adapter. The right rail is the single Log to file control surface.
//
// The graph math lives in pure/graph.ts (series push, time-window trim,
// min/max scaling, downsampling - unit-tested); this file only owns the DOM
// and the thin Canvas drawing.

import { el, clear } from '../dom.ts';
import type { AppState, Page, PageContext } from '../router.ts';
import { consumeOverlayViewRequest } from '../router.ts';
import { api } from '../ipc.ts';
import type { DeviceInfo, FpsSample, TelemetrySample } from '../types.ts';
import { getMonitorLogMetrics, getMonitorLogToFile, setLatestFpsSample, setMonitorLogMetrics, setMonitorLogToFile } from '../log-state.ts';
import { ghzFreq } from '../pure/sysinfo.ts';
import { formatGpuMemoryGb, gpuMemoryLabel } from '../pure/gpu-memory.ts';
import { chipLabelGpu } from '../pure/chip-label.ts';
import { deviceHardwareKey, stripVramSuffix } from '../pure/device.ts';
import { dashboardGpuOrder } from '../pure/dashboard.ts';
import { renderOverlaySettings } from './overlay-settings.ts';
import {
  upsertSeriesPoint,
  trimSeriesWindow,
  nearestSampleIndex,
} from '../pure/graph.ts';
import type { SeriesPoint } from '../pure/graph.ts';
import {
  clampGraphTooltipPosition,
  formatMonitoringGraphValue,
  graphDrawnPoints,
  graphSamplePosition,
  MONITORING_GRAPH_PLOT_BOTTOM_PX,
  monitoringGraphPlotHeight,
  monitoringGraphRangeForMax,
  monitoringGraphSegment,
} from '../pure/monitoring-graph.ts';
import {
  TELEMETRY_HISTORY_POINTS,
  TELEMETRY_HISTORY_WINDOW_LABEL,
  TELEMETRY_HISTORY_WINDOW_S,
  TELEMETRY_PULSE_COLORS,
} from '../pure/telemetry-visuals.ts';

const FPS_POLL_MS = 1000;
// M4-D2 (plan-review M5): the PresentMon mention is gone - the FPS source is
// the DXGI frame-statistics/duplication adapter; unavailable -> honest '-'.
// M17c: the preferred source is the ETW/PresentMon lane (the foreground
// program's per-frame present stream); the DXGI desktop-presentation tier
// is the fallback. The unavailable note covers BOTH sources being silent
// (the 'FPS unavailable' ui-verify prefix is pinned).
const FPS_UNAVAILABLE_NOTE = 'FPS unavailable - no present data is being captured for the foreground program.';
const FPS_CHECKING_NOTE = 'Checking FPS…';

interface MonState {
  deviceId: number | null;
  series: Record<string, SeriesPoint[]>;
  dirtySeries: Set<string>;
  fullRedrawPending: boolean;
  metricCanvases: Map<string, HTMLCanvasElement>;
  graphCeilings: Map<string, number>;
  rangeNodes: Map<string, { min: HTMLElement; max: HTMLElement }>;
  metricGraphs: Map<string, MetricGraphOverlay>;
  fpsTileValue: HTMLElement | null;
  fpsNote: HTMLElement | null;
  metricBindings: MetricBinding[];
  fpsBindings: FpsBinding[];
}

interface MetricReadout {
  value: string;
  unit: string;
}

interface MetricBinding {
  category: string;
  label: string;
  logMetricId: string;
  node: HTMLElement;
  valueNode: HTMLElement;
  unitNode: HTMLElement;
  read: (state: AppState) => MetricReadout;
}

interface FpsBinding {
  category: 'fps';
  label: string;
  node: HTMLElement;
  id: 'fps' | 'frame-time' | 'average' | 'low-1' | 'low-01' | 'p99';
  seriesId: string;
  valueNode: HTMLElement;
  unitNode: HTMLElement;
}

let mon: MonState | null = null;
let fpsTimer: number | null = null;
let graphRedrawFrame: number | null = null;
let monitoringResizeObserver: ResizeObserver | null = null;
const miniCanvasLayouts = new WeakMap<HTMLCanvasElement, { width: number; height: number; dpr: number }>();
// The stress dialog is recreated when the Monitoring tab is rendered. Keep
// the dismissed result identity outside that DOM so a tab switch cannot
// resurrect the same completed run.
let dismissedStabilityRunId: string | null = null;

// M9: the Monitoring page's sub-view - 'monitoring' = the readout grid +
// canvas graphs, 'overlay' = the overlay settings content. Module-level
// (persists across re-renders - a navigation re-entry must not drop the
// active view, the Tuning pattern); the #/overlay alias + the Settings
// "Overlay settings" button force 'overlay' via consumeOverlayViewRequest
// at render.
let monView: 'monitoring' | 'overlay' = 'monitoring';
let viewContainer: HTMLElement | null = null;

/**
 * Drop all DOM-owned Monitoring graph bindings while preserving the rolling
 * sample history. The Overlay sub-view replaces the graph DOM in-place, so a
 * binding that survives that transition would keep detached canvases alive
 * and let telemetry redraw work target nodes the user can no longer see.
 */
function clearMonitoringGraphBindings(): void {
  if (graphRedrawFrame !== null) {
    window.cancelAnimationFrame(graphRedrawFrame);
    graphRedrawFrame = null;
  }
  monitoringResizeObserver?.disconnect();
  monitoringResizeObserver = null;
  if (!mon) return;
  mon.metricCanvases.clear();
  mon.rangeNodes.clear();
  mon.metricGraphs.clear();
  mon.metricBindings = [];
  mon.fpsBindings = [];
  mon.fpsTileValue = null;
  mon.fpsNote = null;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#4cc2ff';
}

/** The same value formatting as the dashboard readout ('-' for null). */
function statValue(v: number | null | undefined, decimals = 0): string {
  return v === undefined || v === null || !Number.isFinite(v) ? '-' : decimals > 0 ? v.toFixed(decimals) : String(Math.round(v));
}

function memoryGb(bytes: number | null | undefined): string {
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? (bytes / 1e9).toFixed(1) : '-';
}

function deviceKeyOf(device: DeviceInfo): string {
  return device.deviceKey ?? deviceHardwareKey(device);
}

function sampleForDevice(state: AppState, device: DeviceInfo): TelemetrySample | null {
  return state.latestSamples[deviceKeyOf(device)] ?? (state.deviceId === device.id ? state.latestSample : null);
}

function systemSample(state: AppState): TelemetrySample | null {
  return state.latestSample ?? Object.values(state.latestSamples)[0] ?? null;
}

function defaultFpsDevice(state: AppState): DeviceInfo | null {
  return state.devices.find((device) => device.displayActive === true)
    ?? state.devices.find((device) => device.id === state.deviceId)
    ?? state.devices[0]
    ?? null;
}

function shortGpuName(device: DeviceInfo): string {
  const plainName = stripVramSuffix(device.name);
  return chipLabelGpu(plainName) ?? plainName;
}

function shortGpuNameFromName(name: string | null | undefined): string {
  const plainName = stripVramSuffix(String(name ?? 'GPU'));
  return chipLabelGpu(plainName) ?? plainName;
}

function gpuGraphKey(deviceKey: string, segmentId: string): string {
  return `gpu:${encodeURIComponent(deviceKey)}:${segmentId}`;
}

interface MetricGraphOverlay {
  surface: HTMLElement;
  canvas: HTMLCanvasElement;
  tooltip: HTMLElement;
  crosshair: HTMLElement;
  yMax: HTMLElement;
  yMin: HTMLElement;
  pointerRatio: number | null;
}

function systemGraphKey(segmentId: string): string {
  return `system-${segmentId}`;
}

function setGraphCeiling(seriesId: string, value: number | null | undefined): void {
  if (!mon || !Number.isFinite(value) || Number(value) <= 0) return;
  const previous = mon.graphCeilings.get(seriesId) ?? 0;
  if (Number(value) > previous) {
    mon.graphCeilings.set(seriesId, Number(value));
    mon.dirtySeries.add(seriesId);
  }
}

/**
 * Seed capacity ceilings from the current machine. The same map receives
 * per-series high-water marks from pushMetricSeries, so a transient value
 * above a default or physical capacity remains visible for this session.
 */
function refreshMonitoringGraphCeilings(state: AppState): void {
  if (!mon) return;
  const ramBytes = state.sysinfo?.ram.totalBytes;
  if (Number.isFinite(ramBytes) && Number(ramBytes) > 0) {
    const ramGb = Number(ramBytes) / 1e9;
    setGraphCeiling(systemGraphKey('ram-used'), ramGb);
    setGraphCeiling(systemGraphKey('ram-capacity'), ramGb);
  }
  const seedGpuVramCeiling = (key: string, vramBytes: number | null | undefined, sharedMemoryBytes?: number | null, useShared = false): void => {
    // Dedicated capacity is preferred. Integrated/mobile adapters expose
    // shared capacity instead, which is meaningful for their shared-memory
    // graph.
    const capacityBytes = vramBytes ?? (useShared ? sharedMemoryBytes : null);
    if (Number.isFinite(capacityBytes) && Number(capacityBytes) > 0) {
      setGraphCeiling(gpuGraphKey(key, 'vram'), Number(capacityBytes) / 1e9);
    }
  };
  state.devices.forEach((device) => {
    seedGpuVramCeiling(
      device.deviceKey ?? deviceHardwareKey(device),
      device.vramBytes,
      device.sharedMemoryBytes,
      device.integrated === true || device.mobile === true,
    );
  });
  if (state.devices.length === 0 && state.osGpu) {
    seedGpuVramCeiling('vendor', state.osGpu.vramBytes, state.osGpu.sharedMemoryBytes, true);
  }
}

function fpsGraphKey(id: FpsBinding['id']): string {
  return `fps-${id}`;
}

function graphSegment(seriesId: string): string {
  return monitoringGraphSegment(seriesId);
}

function pushMetricSeries(seriesId: string, t: number, value: number | undefined): void {
  if (!mon || value === undefined || !Number.isFinite(value)) return;
  setGraphCeiling(seriesId, value);
  const current = mon.series[seriesId] ?? [];
  // onUpdate can run once for each adapter while the other adapter's latest
  // sample is unchanged. The pure upsert helper skips identical duplicates,
  // replaces a changed tail in place, and only sorts the rare old timestamp.
  const next = upsertSeriesPoint(current, t, value, TELEMETRY_HISTORY_POINTS);
  if (next === current) return;
  mon.series[seriesId] = trimSeriesWindow(
    next,
    t,
    TELEMETRY_HISTORY_WINDOW_S,
  );
  mon.dirtySeries.add(seriesId);
}

function updateMetricBindings(state: AppState): void {
  if (!mon) return;
  for (const binding of mon.metricBindings) {
    const readout = binding.read(state);
    binding.valueNode.textContent = readout.value;
    binding.unitNode.textContent = readout.unit;
  }
}

function metricNode(
  label: string,
  read: (state: AppState) => MetricReadout,
  state: AppState,
  extraClass = '',
  category = 'system',
  seriesId?: string,
  logMetricId = `${category}:${label}`,
): HTMLElement {
  const readout = read(state);
  const valueNode = el('div', { class: 'telemetry-metric-value stat-value', text: readout.value });
  const unitNode = el('div', { class: 'telemetry-metric-unit stat-unit', text: readout.unit });
  const sparkline = seriesId
    ? el('canvas', { class: 'telemetry-metric-sparkline' })
    : el('div', { class: 'telemetry-metric-sparkline telemetry-metric-sparkline-empty', 'aria-hidden': 'true' });
  const graph = el('div', { class: 'telemetry-metric-graph' }, [
    seriesId && sparkline instanceof HTMLCanvasElement
      ? graphSurface(seriesId, label, sparkline)
      : sparkline,
  ]);
  if (seriesId && mon) {
    const min = el('strong', { text: '—' });
    const max = el('strong', { text: '—' });
    mon.rangeNodes.set(seriesId, { min, max });
    graph.append(el('div', { class: 'telemetry-graph-range', 'aria-label': `${label} graph range` }, [
      el('span', {}, [el('span', { class: 'telemetry-graph-range-label', text: 'Min' }), min]),
      el('span', {}, [el('span', { class: 'telemetry-graph-range-label', text: 'Max' }), max]),
    ]));
  }
  const node = el('div', { class: `telemetry-metric stat-tile${extraClass ? ` ${extraClass}` : ''}`, dataset: { metricId: `${category}:${label}` } }, [
    el('div', { class: 'telemetry-metric-copy' }, [
      el('div', { class: 'telemetry-metric-value-line' }, [valueNode, unitNode]),
      el('div', { class: 'telemetry-metric-label stat-label', text: label }),
    ]),
    graph,
  ]);
  if (mon) {
    mon.metricBindings.push({ category, label, logMetricId, node, valueNode, unitNode, read });
    if (seriesId && sparkline instanceof HTMLCanvasElement) mon.metricCanvases.set(seriesId, sparkline);
  }
  return node;
}

function cpuMetricNodes(state: AppState): HTMLElement[] {
  return [
    metricNode('Util', (s) => ({ value: statValue(systemSample(s)?.cpuUtilPct), unit: '%' }), state, '', 'cpu', systemGraphKey('cpu-util'), 'cpu-util'),
    metricNode('Core Frequency', (s) => ({ value: ghzFreq(systemSample(s)?.cpuFreqMhz), unit: 'GHz' }), state, '', 'cpu', systemGraphKey('cpu-clock'), 'cpu-clock'),
    metricNode('Temperature', (s) => ({ value: statValue(systemSample(s)?.cpuTempC), unit: '°C' }), state, '', 'cpu', systemGraphKey('cpu-temp'), 'cpu-temp'),
    metricNode('Power', (s) => ({ value: statValue(systemSample(s)?.cpuPowerW, 1), unit: 'W' }), state, '', 'cpu', systemGraphKey('cpu-power'), 'cpu-power'),
  ];
}

function systemMetricNodes(state: AppState): HTMLElement[] {
  return [
    metricNode('RAM in use', (s) => ({ value: memoryGb(systemSample(s)?.memoryUsedBytes), unit: 'GB' }), state, '', 'system-memory', systemGraphKey('ram-used'), 'system-memory'),
    metricNode('RAM capacity', (s) => ({ value: memoryGb(s.sysinfo?.ram.totalBytes), unit: 'GB' }), state, '', 'system-memory', systemGraphKey('ram-capacity'), 'system-memory-capacity'),
  ];
}

function gpuMetricNodes(device: DeviceInfo | null, state: AppState): HTMLElement[] {
  const readSample = (s: AppState): TelemetrySample | null => device ? sampleForDevice(s, device) : systemSample(s);
  const sample = readSample(state);
  const sharedMemoryGpu = device?.integrated === true || device?.mobile === true;
  // Built-in/mobile adapters do not expose a physical board fan through the
  // Intel telemetry surface. Do not render an empty Fan 1 tile for them.
  const fanCount = sharedMemoryGpu ? 0 : Math.max(1, sample?.fanRpm?.length ?? 1);
  const category = device ? `gpu-${device.id}` : 'gpu-vendor';
  const series = (segmentId: string): string | undefined => gpuGraphKey(device ? deviceKeyOf(device) : 'vendor', segmentId);
  const nodes = [
    metricNode('Util', (s) => {
      const v = readSample(s);
      return { value: statValue(v?.gpuUtilPct ?? v?.utilPct), unit: '%' };
    }, state, '', category, series('util'), 'gpu-util'),
    metricNode('Core clock', (s) => ({ value: statValue(readSample(s)?.gpuClockMhz), unit: 'MHz' }), state, '', category, series('clock'), 'gpu-clock'),
    metricNode('Voltage', (s) => ({ value: statValue(readSample(s)?.gpuVoltageV, 3), unit: 'V' }), state, '', category, series('voltage'), 'gpu-voltage'),
    metricNode('Temperature', (s) => ({ value: statValue(readSample(s)?.tempC), unit: '°C' }), state, '', category, series('temp'), 'gpu-temperature'),
    metricNode('Power', (s) => ({ value: statValue(readSample(s)?.powerW, 1), unit: 'W' }), state, '', category, series('power'), 'gpu-power'),
  ];
  for (let fan = 0; fan < fanCount; fan++) {
    nodes.push(metricNode(`Fan ${fan + 1}`, (s) => ({ value: statValue(readSample(s)?.fanRpm?.[fan]), unit: 'RPM' }), state, '', category, fan === 0 ? series('fan') : undefined, fan === 0 ? 'gpu-fan' : `gpu-fan-${fan + 1}`));
  }
  return nodes;
}

function gpuMemoryMetricNodes(device: DeviceInfo | null, state: AppState): HTMLElement[] {
  const readSample = (s: AppState): TelemetrySample | null => device ? sampleForDevice(s, device) : systemSample(s);
  const category = device ? `gpu-memory-${device.id}` : 'gpu-memory-vendor';
  const sharedMemoryGpu = device?.integrated === true || device?.mobile === true;
  if (sharedMemoryGpu) {
    return [
      metricNode('Shared memory in use', (s) => {
        const v = readSample(s);
        return { value: formatGpuMemoryGb(v?.gpuMemUsedBytes), unit: 'GB shared' };
      }, state, '', category, gpuGraphKey(device ? deviceKeyOf(device) : 'vendor', 'vram'), 'gpu-shared-memory'),
    ];
  }
  return [
    metricNode('VRAM in use', (s) => {
      const v = readSample(s);
      return { value: formatGpuMemoryGb(v?.gpuMemUsedBytes), unit: gpuMemoryLabel(v?.gpuMemorySource) === 'VRAM' ? 'GB' : 'GB shared' };
    }, state, '', category, gpuGraphKey(device ? deviceKeyOf(device) : 'vendor', 'vram'), 'gpu-vram'),
    metricNode('Memory clock', (s) => ({ value: statValue(readSample(s)?.memClockMhz), unit: 'MHz' }), state, '', category, gpuGraphKey(device ? deviceKeyOf(device) : 'vendor', 'mem-clock'), 'gpu-memory-clock'),
    metricNode('VramTemp', (s) => ({ value: statValue(readSample(s)?.vramTempC), unit: '°C' }), state, '', category, gpuGraphKey(device ? deviceKeyOf(device) : 'vendor', 'vram-temp'), 'gpu-vram-temperature'),
  ];
}

function fpsMetricNode(label: string, id: FpsBinding['id'], unit: string): HTMLElement {
  const valueNode = el('div', { class: 'telemetry-metric-value stat-value', text: '-' });
  const unitNode = el('div', { class: 'telemetry-metric-unit stat-unit', text: unit });
  const seriesId = fpsGraphKey(id);
  const canvas = el('canvas', { class: 'telemetry-metric-sparkline' });
  const min = el('strong', { text: '—' });
  const max = el('strong', { text: '—' });
  const graph = el('div', { class: 'telemetry-metric-graph' }, [
    graphSurface(seriesId, label, canvas),
    el('div', { class: 'telemetry-graph-range', 'aria-label': `${label} graph range` }, [
      el('span', {}, [el('span', { class: 'telemetry-graph-range-label', text: 'Min' }), min]),
      el('span', {}, [el('span', { class: 'telemetry-graph-range-label', text: 'Max' }), max]),
    ]),
  ]);
  const node = el('div', { class: `telemetry-metric stat-tile${id === 'fps' ? ' mon-fps-tile' : ''}`, dataset: { metricId: `fps:${label}` } }, [
    el('div', { class: 'telemetry-metric-copy' }, [
      el('div', { class: 'telemetry-metric-value-line' }, [valueNode, unitNode]),
      el('div', { class: 'telemetry-metric-label stat-label', text: label }),
    ]),
    graph,
  ]);
  if (mon) {
    mon.fpsBindings.push({ category: 'fps', label, node, id, seriesId, valueNode, unitNode });
    mon.rangeNodes.set(seriesId, { min, max });
    mon.metricCanvases.set(seriesId, canvas);
  }
  return node;
}

function refreshFpsMetrics(sample: FpsSample | null): void {
  if (!mon) return;
  const values: Record<FpsBinding['id'], { value: string; unit: string }> = {
    fps: { value: statValue(sample?.fps), unit: 'FPS' },
    'frame-time': { value: statValue(sample?.frameTimeMs, 1), unit: 'ms' },
    average: { value: statValue(sample?.avgFps), unit: 'FPS' },
    'low-1': { value: statValue(sample?.low1Pct), unit: 'FPS' },
    'low-01': { value: statValue(sample?.low01Pct), unit: 'FPS' },
    p99: { value: statValue(sample?.p99), unit: 'FPS' },
  };
  const rawValue = (id: FpsBinding['id']): number | undefined => {
    if (!sample) return undefined;
    switch (id) {
      case 'fps': return sample.fps ?? undefined;
      case 'frame-time': return sample.frameTimeMs ?? undefined;
      case 'average': return sample.avgFps ?? undefined;
      case 'low-1': return sample.low1Pct ?? undefined;
      case 'low-01': return sample.low01Pct ?? undefined;
      case 'p99': return sample.p99 ?? undefined;
    }
  };
  const now = Date.now() / 1000;
  for (const binding of mon.fpsBindings) {
    binding.valueNode.textContent = values[binding.id].value;
    binding.unitNode.textContent = values[binding.id].unit;
    pushMetricSeries(binding.seriesId, now, rawValue(binding.id));
  }
}

function monitoringSeriesColor(seriesId: string, accentColor = cssVar('--accent')): string {
  const segment = graphSegment(seriesId);
  if (segment === 'util' || segment === 'cpu-util') return TELEMETRY_PULSE_COLORS.utilization;
  if (segment === 'temp' || segment === 'vram-temp' || segment === 'cpu-temp') return TELEMETRY_PULSE_COLORS.temperature;
  if (segment === 'power' || segment === 'cpu-power' || segment === 'voltage') return TELEMETRY_PULSE_COLORS.power;
  if (segment === 'vram' || segment === 'ram-used' || segment === 'ram-capacity' || segment === 'fan') return TELEMETRY_PULSE_COLORS.memory;
  return accentColor;
}

function graphRangeValue(seriesId: string, value: number): string {
  return formatMonitoringGraphValue(seriesId, value);
}

function seriesObservedRange(points: SeriesPoint[]): { min: number; max: number } | null {
  if (points.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    if (point.v < min) min = point.v;
    if (point.v > max) max = point.v;
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

function graphSurface(
  seriesId: string,
  label: string,
  canvas: HTMLCanvasElement,
): HTMLElement {
  const yMax = el('span', { class: 'telemetry-graph-axis-label telemetry-graph-axis-y telemetry-graph-axis-y-max', hidden: true });
  const yMin = el('span', { class: 'telemetry-graph-axis-label telemetry-graph-axis-y telemetry-graph-axis-y-min', hidden: true });
  const crosshair = el('span', { class: 'telemetry-graph-crosshair', hidden: true, 'aria-hidden': 'true' });
  const tooltip = el('span', { class: 'telemetry-graph-tooltip', hidden: true, role: 'status' });
  const grid = el('div', { class: 'telemetry-graph-grid', 'aria-hidden': 'true' }, [
    el('span', { class: 'telemetry-graph-grid-line telemetry-graph-grid-h telemetry-graph-grid-top' }),
    el('span', { class: 'telemetry-graph-grid-line telemetry-graph-grid-h telemetry-graph-grid-mid' }),
    el('span', { class: 'telemetry-graph-grid-line telemetry-graph-grid-h telemetry-graph-grid-bottom' }),
    el('span', { class: 'telemetry-graph-grid-line telemetry-graph-grid-v telemetry-graph-grid-left' }),
    el('span', { class: 'telemetry-graph-grid-line telemetry-graph-grid-v telemetry-graph-grid-quarter' }),
    el('span', { class: 'telemetry-graph-grid-line telemetry-graph-grid-v telemetry-graph-grid-half' }),
    el('span', { class: 'telemetry-graph-grid-line telemetry-graph-grid-v telemetry-graph-grid-three-quarter' }),
    el('span', { class: 'telemetry-graph-grid-line telemetry-graph-grid-v telemetry-graph-grid-right' }),
  ]);
  const axisRail = el('div', { class: 'telemetry-graph-axis-rail', 'aria-hidden': 'true' }, [yMax, yMin]);
  const surface = el('div', { class: 'telemetry-metric-graph-surface', 'aria-label': `${label} graph` }, [
    canvas,
    crosshair,
    tooltip,
    grid,
  ]);
  // Keep the plot surface at its existing size while giving the Y readouts a
  // dedicated rail immediately to its left. The rail is part of the graph
  // layout, so labels never paint over the line or the hover pill.
  const layout = el('div', { class: 'telemetry-metric-graph-layout' }, [axisRail, surface]);
  if (mon) {
    const graph: MetricGraphOverlay = {
      surface,
      canvas,
      tooltip,
      crosshair,
      yMax,
      yMin,
      pointerRatio: null,
    };
    mon.metricGraphs.set(seriesId, graph);
    const hide = (): void => {
      graph.pointerRatio = null;
      tooltip.hidden = true;
      crosshair.hidden = true;
    };
    surface.addEventListener('pointermove', (event) => {
      const rect = surface.getBoundingClientRect();
      if (rect.width <= 0) return;
      graph.pointerRatio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      updateMetricGraphOverlay(seriesId);
    });
    surface.addEventListener('pointerleave', hide);
  }
  return layout;
}

function updateMetricGraphOverlay(seriesId: string, observed?: { min: number; max: number } | null): void {
  if (!mon) return;
  const graph = mon.metricGraphs.get(seriesId);
  if (!graph) return;
  const series = mon.series[seriesId] ?? [];
  const observedRange = observed === undefined ? seriesObservedRange(series) : observed;
  const range = monitoringGraphRangeForMax(seriesId, observedRange?.max, mon.graphCeilings.get(seriesId));
  if (!observedRange || !range) {
    graph.yMax.hidden = true;
    graph.yMin.hidden = true;
    graph.crosshair.hidden = true;
    graph.tooltip.hidden = true;
    return;
  }
  graph.yMax.textContent = graphRangeValue(seriesId, range.max);
  graph.yMin.textContent = graphRangeValue(seriesId, range.min);
  graph.yMax.hidden = false;
  graph.yMin.hidden = false;
  if (graph.pointerRatio === null || series.length === 0) return;
  // Hover the same downsampled points that drawMiniSeries paints. A full
  // history can contain samples that are not present in the Canvas polyline;
  // selecting one of those would place the crosshair beside the visible line.
  const points = graphDrawnPoints(series);
  const index = nearestSampleIndex(points, graph.pointerRatio);
  if (index < 0) return;
  const point = points[index];
  const rect = graph.surface.getBoundingClientRect();
  const width = graph.surface.clientWidth || rect.width;
  const height = graph.surface.clientHeight || rect.height;
  const position = graphSamplePosition(points, index, width, height, range);
  if (!position) return;
  const { x, y } = position;
  graph.crosshair.style.left = `${x}px`;
  graph.crosshair.hidden = false;
  graph.tooltip.textContent = graphRangeValue(seriesId, point.v);
  graph.tooltip.hidden = false;
  // Measure after updating the value so the compact text stays inside the
  // frame while switching sides of the crosshair at the horizontal midpoint.
  const textWidth = graph.tooltip.offsetWidth || 28;
  const textHeight = graph.tooltip.offsetHeight || 10;
  const tooltipPosition = clampGraphTooltipPosition(x, y, width, height, textWidth, textHeight);
  graph.tooltip.style.left = `${tooltipPosition.left}px`;
  graph.tooltip.style.top = `${tooltipPosition.top}px`;
}

/** Dashboard-style compact history strip for each readout row. */
function drawMiniSeries(canvas: HTMLCanvasElement, points: SeriesPoint[], seriesId: string, color = cssVar('--accent'), ceiling?: number): { min: number; max: number } | null {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = Math.round(canvas.clientWidth);
  const h = Math.round(canvas.clientHeight);
  if (w <= 0 || h <= 0) return null;
  const previousLayout = miniCanvasLayouts.get(canvas);
  const pixelWidth = Math.max(1, Math.round(w * dpr));
  const pixelHeight = Math.max(1, Math.round(h * dpr));
  // Resizing a canvas clears its backing store and reallocates the bitmap.
  // The telemetry tick used to do that for every graph on every update,
  // which could visibly flash or tear when two adapter lanes arrived close
  // together. Resize only when layout or display density actually changed.
  if (!previousLayout
    || previousLayout.width !== w
    || previousLayout.height !== h
    || previousLayout.dpr !== dpr
    || canvas.width !== pixelWidth
    || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    miniCanvasLayouts.set(canvas, { width: w, height: h, dpr });
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (points.length === 0) return null;
  // The labels and line share the same metric-aware axis: utilization is
  // always 0..100 and every other metric starts at 0 and ends at its largest
  // reported value. The observed range is returned separately so the
  // existing Min/Max readout below the graph remains useful.
  const range = seriesObservedRange(points);
  const axisRange = monitoringGraphRangeForMax(seriesId, range?.max, ceiling);
  if (!range || !axisRange) return null;
  const { min, max } = axisRange;
  const span = Math.max(0.001, max - min);
  const drawn = graphDrawnPoints(points);
  const timeSpan = Math.max(0.001, drawn[drawn.length - 1].t - drawn[0].t);
  const x = (point: SeriesPoint): number => drawn.length <= 1
    ? w / 2
    : ((point.t - drawn[0].t) / timeSpan) * (w - 4) + 2;
  // Reserve the lower strip for the hover time label. Keep this coordinate
  // system in lockstep with updateMetricGraphOverlay so the crosshair and
  // pill remain attached to the rendered line after a resize.
  const y = (value: number): number => h - MONITORING_GRAPH_PLOT_BOTTOM_PX
    - ((value - min) / span) * monitoringGraphPlotHeight(h);
  ctx.beginPath();
  drawn.forEach((point, index) => {
    const px = x(point);
    const py = y(point.v);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  return range;
}

async function pollFps(): Promise<void> {
  if (!mon || mon.deviceId === null) return;
  let sample: FpsSample | null = null;
  try {
    sample = await api.fpsPoll(mon.deviceId);
  } catch {
    sample = null;
  }
  if (!mon) return; // navigated away while polling
  // M4-D2 (§10): the log-to-file sender reads the latest FPS through the
  // shared module - the log line carries the best-effort fps even when the
  // Monitoring page is not the current page (the BOOT-level subscription
  // does the logging).
  setLatestFpsSample(sample as unknown as Record<string, unknown> | null);
  refreshFpsMetrics(sample);
  if (mon.fpsTileValue && mon.fpsNote) {
    if (sample && sample.fps !== null && Number.isFinite(sample.fps)) {
      mon.fpsTileValue.textContent = String(Math.round(sample.fps));
      mon.fpsNote.textContent = sample.frameTimeMs !== null ? `Frame time ${sample.frameTimeMs.toFixed(1)} ms` : '';
    } else {
      mon.fpsTileValue.textContent = '-';
      mon.fpsNote.textContent = FPS_UNAVAILABLE_NOTE;
    }
  }
}

export const monitoringPage: Page = {
  id: 'monitoring',

  render(container: HTMLElement, ctx: PageContext) {
    // Navigation re-entry: stop the previous poll loop, reset the state.
    if (fpsTimer !== null) {
      window.clearInterval(fpsTimer);
      fpsTimer = null;
    }
    const s = ctx.store.get();
    mon = {
      deviceId: defaultFpsDevice(s)?.id ?? null,
      series: {},
      dirtySeries: new Set(),
      fullRedrawPending: false,
      metricCanvases: new Map(),
      graphCeilings: new Map(),
      rangeNodes: new Map(),
      metricGraphs: new Map(),
      fpsTileValue: null,
      fpsNote: null,
      metricBindings: [],
      fpsBindings: [],
    };

    // M9: the old #/overlay hash + the Settings-button path arrive with the
    // overlay view requested (the consumeFanViewRequest twin - the Tuning
    // pattern); the view persists per render (module state, default
    // 'monitoring').
    if (consumeOverlayViewRequest()) monView = 'overlay';

    clear(container);
    const viewToggle = el('div', { class: 'mon-view-toggle-row' }, [
      el('div', { class: 'oc-mode-toggle mon-view-toggle', role: 'group', 'aria-label': 'Monitoring view' }, [
        el('button', {
          class: `oc-mode-btn mon-view-btn${monView === 'monitoring' ? ' active' : ''}`,
          dataset: { view: 'monitoring' },
          text: 'Monitoring',
          onClick: () => setMonView('monitoring'),
        }),
        el('button', {
          class: `oc-mode-btn mon-view-btn${monView === 'overlay' ? ' active' : ''}`,
          dataset: { view: 'overlay' },
          text: 'Overlay',
          onClick: () => setMonView('overlay'),
        }),
      ]),
    ]);
    viewContainer = el('div', { class: 'mon-view' });
    container.append(
      el('h1', { class: 'page-title', text: monView === 'overlay' ? 'Overlay' : 'Monitoring' }),
      el('p', {
        class: 'page-subtitle',
        text: monView === 'overlay'
          ? 'The in-game HUD - enable it, pick the stats, colors, size, position and hotkey.'
          : `Live values and ${TELEMETRY_HISTORY_WINDOW_LABEL} rolling graphs from the GPU.`,
      }),
      viewToggle,
      viewContainer,
    );
    // M9: the view switch re-renders ONLY the sub-view container - the
    // telemetry series (module-level mon.series) survive the round trip,
    // and every monitoring-view rebuild re-registers the metric canvases +
    // the FPS tile + the note (the S2 contract in renderMonitoringView).
    const renderMonView = (): void => {
      if (!viewContainer) return;
      if (monView === 'overlay') {
        clearMonitoringGraphBindings();
        renderOverlaySettings(viewContainer, ctx);
        return;
      }
      renderMonitoringView(viewContainer, ctx);
    };
    const setMonView = (v: 'monitoring' | 'overlay'): void => {
      if (monView === v) return;
      monView = v;
      renderMonView();
      viewToggle.querySelectorAll<HTMLButtonElement>('.mon-view-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.view === monView);
      });
    };
    renderMonView();

    fpsTimer = window.setInterval(() => void pollFps(), FPS_POLL_MS);
    void pollFps();
    redrawAll();
  },

  // M2b review F4: the router calls this on navigation away - the 1 s FPS
  // poll must not keep firing (and touching stale DOM) on other pages.
  leave() {
    if (fpsTimer !== null) {
      window.clearInterval(fpsTimer);
      fpsTimer = null;
    }
    clearMonitoringGraphBindings();
    viewContainer = null;
    mon = null;
  },

  onUpdate(container: HTMLElement, ctx: PageContext) {
    if (!mon) return;
    const state = ctx.store.get();
    refreshMonitoringGraphCeilings(state);
    const stabilityPanel = container.querySelector<HTMLElement>('[data-stability-lab]');
    if (stabilityPanel) updateStabilityLabPanel(stabilityPanel, state);
    const telemetryDevices: Array<DeviceInfo | null> = state.devices.length > 0 ? state.devices : [null];
    for (const device of telemetryDevices) {
      const sample = device ? sampleForDevice(state, device) : systemSample(state);
      const now = sample?.t ?? Date.now();
      const t = now > 10_000_000_000 ? now / 1000 : now;
      const key = device ? deviceKeyOf(device) : 'vendor';
      pushMetricSeries(gpuGraphKey(key, 'util'), t, sample?.gpuUtilPct ?? sample?.utilPct);
      pushMetricSeries(gpuGraphKey(key, 'clock'), t, sample?.gpuClockMhz);
      pushMetricSeries(gpuGraphKey(key, 'voltage'), t, sample?.gpuVoltageV);
      pushMetricSeries(gpuGraphKey(key, 'temp'), t, sample?.tempC);
      pushMetricSeries(gpuGraphKey(key, 'power'), t, sample?.powerW);
      pushMetricSeries(gpuGraphKey(key, 'fan'), t, sample?.fanRpm?.[0]);
      pushMetricSeries(gpuGraphKey(key, 'vram'), t, sample?.gpuMemUsedBytes === null || sample?.gpuMemUsedBytes === undefined
        ? undefined
        : sample.gpuMemUsedBytes / 1e9);
      pushMetricSeries(gpuGraphKey(key, 'mem-clock'), t, sample?.memClockMhz);
      pushMetricSeries(gpuGraphKey(key, 'vram-temp'), t, sample?.vramTempC);
    }
    const sample = systemSample(state);
    const now = sample?.t ?? Date.now();
    const t = now > 10_000_000_000 ? now / 1000 : now;
    pushMetricSeries(systemGraphKey('cpu-util'), t, sample?.cpuUtilPct ?? undefined);
    pushMetricSeries(systemGraphKey('cpu-clock'), t, sample?.cpuFreqMhz ?? undefined);
    pushMetricSeries(systemGraphKey('cpu-temp'), t, sample?.cpuTempC ?? undefined);
    pushMetricSeries(systemGraphKey('cpu-power'), t, sample?.cpuPowerW ?? undefined);
    pushMetricSeries(systemGraphKey('ram-used'), t, sample?.memoryUsedBytes === null || sample?.memoryUsedBytes === undefined
      ? undefined
      : sample.memoryUsedBytes / 1e9);
    pushMetricSeries(systemGraphKey('ram-capacity'), t, state.sysinfo?.ram.totalBytes === null || state.sysinfo?.ram.totalBytes === undefined
      ? undefined
      : state.sysinfo.ram.totalBytes / 1e9);
    updateMetricBindings(state);
    redrawAll();
  },
};

/** M9: the monitoring sub-view build. Every rebuild re-registers the live
 *  metric canvases, FPS tile and note so navigation never leaves detached
 *  controls receiving updates. */
function telemetryPanel(
  key: string,
  title: string,
  badge: string,
  bodyChildren: HTMLElement[],
  open = true,
  id?: string,
): HTMLElement {
  const body = el('div', { class: 'telemetry-panel-body' }, [
    el('div', { class: 'telemetry-metric-grid' }, bodyChildren),
  ]);
  body.hidden = !open;
  const head = el('button', {
    class: 'telemetry-panel-head',
    type: 'button',
    'aria-expanded': String(open),
    onClick: () => {
      const nextOpen = body.hidden;
      body.hidden = !nextOpen;
      head.setAttribute('aria-expanded', String(nextOpen));
      head.querySelector('.telemetry-panel-chevron')!.textContent = nextOpen ? '▾' : '▸';
    },
  }, [
    el('span', { class: 'telemetry-panel-chevron', text: open ? '▾' : '▸' }),
    el('span', { class: 'telemetry-panel-title', text: title }),
    el('span', { class: 'telemetry-panel-badge', text: badge }),
  ]);
  return el('section', { class: 'card telemetry-panel', id, dataset: { telemetryPanel: key } }, [head, body]);
}

interface TrackingEntry {
  label: string;
  metricId: string;
}

function trackingGroup(key: string, title: string, subtitle: string, entries: TrackingEntry[]): HTMLElement {
  const body = el('div', { class: 'telemetry-tracking-options', hidden: true });
  const chevron = el('span', { class: 'telemetry-tracking-chevron', text: '▸' });
  const head = el('button', {
    class: 'telemetry-tracking-group-head',
    type: 'button',
    'aria-expanded': 'false',
    onClick: () => {
      const open = body.hidden;
      body.hidden = !open;
      head.setAttribute('aria-expanded', String(open));
      chevron.textContent = open ? '▾' : '▸';
    },
  }, [
    chevron,
    el('span', { class: 'telemetry-tracking-group-copy' }, [
      el('strong', { text: title }),
      el('small', { text: subtitle }),
    ]),
    el('span', { class: 'telemetry-tracking-count', text: `${entries.length}` }),
  ]);
  for (const entry of entries) {
    const isEnabled = getMonitorLogMetrics().includes(entry.metricId);
    const toggle = el('button', {
      class: `telemetry-tracking-toggle${isEnabled ? ' active' : ''}`,
      type: 'button',
      'aria-pressed': String(isEnabled),
      dataset: { logMetric: entry.metricId },
      title: `Include ${entry.label} in the log file`,
      onClick: async () => {
        const nextEnabled = !getMonitorLogMetrics().includes(entry.metricId);
        const next = getMonitorLogMetrics().filter((metric) => metric !== entry.metricId);
        if (nextEnabled) next.push(entry.metricId);
        toggle.disabled = true;
        try {
          await api.profilesSettingsSave({ monitorLogMetrics: next });
          setMonitorLogMetrics(next);
          document.querySelectorAll<HTMLButtonElement>('[data-log-metric]').forEach((button) => {
            if (button.dataset.logMetric !== entry.metricId) return;
            button.classList.toggle('active', nextEnabled);
            button.setAttribute('aria-pressed', String(nextEnabled));
            const state = button.querySelector('.telemetry-tracking-toggle-state');
            if (state) state.textContent = nextEnabled ? 'On' : 'Off';
          });
        } catch {
          // Keep the previous persisted selection when the settings write fails.
        } finally {
          toggle.disabled = false;
        }
      },
    }, [
      el('span', { class: 'telemetry-tracking-option-label', text: entry.label }),
      el('span', { class: 'telemetry-tracking-toggle-state', text: isEnabled ? 'On' : 'Off' }),
    ]);
    body.append(el('div', { class: 'telemetry-tracking-option' }, [el('span', { class: 'telemetry-tracking-option-mark', text: '•' }), el('span', { class: 'telemetry-tracking-option-copy' }, [el('span', { text: entry.label })]), toggle]));
  }
  return el('section', { class: 'telemetry-tracking-group', dataset: { trackingGroup: key } }, [head, body]);
}

function renderTrackingPanel(state: AppState): HTMLElement {
  if (!mon) return el('aside', { class: 'card telemetry-tracking-card' });
  const byCategory = new Map<string, TrackingEntry[]>();
  const add = (category: string, label: string, metricId: string): void => {
    const list = byCategory.get(category) ?? [];
    if (!list.some((entry) => entry.metricId === metricId)) list.push({ label, metricId });
    byCategory.set(category, list);
  };
  mon.metricBindings.forEach((binding) => add(binding.category, binding.label, binding.logMetricId));
  mon.fpsBindings.forEach((binding) => add(binding.category, binding.label, binding.id === 'fps' ? 'fps' : binding.id === 'frame-time' ? 'frame-time' : binding.id === 'average' ? 'fps-average' : binding.id === 'low-1' ? 'fps-1-low' : binding.id === 'low-01' ? 'fps-0.1-low' : 'fps-p99'));
  const groups: Array<{ key: string; title: string; subtitle: string }> = [
    { key: 'fps', title: 'FPS', subtitle: 'Frame pacing' },
    { key: 'cpu', title: 'CPU', subtitle: 'Processor' },
    { key: 'system-memory', title: 'System Memory', subtitle: 'RAM' },
  ];
  dashboardGpuOrder(state.devices).forEach((device, index) => {
    const label = `GPU ${index + 1}`;
    const badge = shortGpuName(device);
    groups.push({ key: `gpu-${device.id}`, title: label, subtitle: badge });
    groups.push({ key: `gpu-memory-${device.id}`, title: `${label} Memory`, subtitle: badge });
  });
  if (state.devices.length === 0 && state.osGpu) {
    const badge = shortGpuNameFromName(state.osGpu.name);
    groups.push({ key: 'gpu-vendor', title: 'GPU', subtitle: badge });
    groups.push({ key: 'gpu-memory-vendor', title: 'GPU Memory', subtitle: badge });
  }
  const groupNodes = groups
    .map((group) => ({ group, entries: byCategory.get(group.key) ?? [] }))
    .filter(({ entries }) => entries.length > 0)
    .map(({ group, entries }) => trackingGroup(group.key, group.title, group.subtitle, entries));

  const logButton = el('button', {
    class: 'btn btn-primary telemetry-log-button',
    type: 'button',
    text: getMonitorLogToFile() ? 'Stop logging' : 'Start logging',
    onClick: async () => {
      const next = !getMonitorLogToFile();
      logButton.disabled = true;
      try {
        await api.profilesSettingsSave({ monitorLogToFile: next });
        setMonitorLogToFile(next);
        logButton.textContent = next ? 'Stop logging' : 'Start logging';
      } catch {
        logButton.textContent = 'Logging unavailable';
      } finally {
        logButton.disabled = false;
      }
    },
  });
  const list = el('div', { class: 'telemetry-tracking-list' }, groupNodes);
  return el('aside', { class: 'card telemetry-tracking-card', dataset: { logCard: 'true' } }, [
    el('div', { class: 'telemetry-tracking-heading' }, [
      el('div', {}, [el('h2', { class: 'card-title', text: 'Log to file' }), el('p', { class: 'card-note', text: 'Choose the metrics written to the telemetry log.' })]),
      el('span', { class: 'telemetry-tracking-live', text: getMonitorLogToFile() ? 'Logging' : 'Ready' }),
    ]),
    logButton,
    el('div', { class: 'telemetry-sampling-row' }, [
      el('span', { text: 'Sampling interval' }),
      el('strong', { text: '1 s' }),
    ]),
    el('div', { class: 'telemetry-tracking-label', text: 'Metrics to log' }),
    list,
  ]);
}

function stabilityOutcomeLabel(outcome: string | null | undefined): string {
  if (outcome === 'passed') return 'Passed';
  if (outcome === 'warning') return 'Warning';
  if (outcome === 'no-workload') return 'No workload detected';
  if (outcome === 'unavailable') return 'Unavailable';
  if (outcome === 'cancelled') return 'Cancelled';
  return 'Ready';
}

function stressMetricText(value: number | null | undefined): string {
  return Number.isFinite(value) ? Math.round(Number(value)).toLocaleString('en-US') : '—';
}

function stressVramText(bytes: number | null | undefined): string {
  return Number.isFinite(bytes) ? `${Math.round(Number(bytes) / 1e9).toLocaleString('en-US')} GB` : '—';
}

function stressMetricFill(key: string, value: number | null | undefined, limits: Record<string, number>): number {
  if (!Number.isFinite(value)) return 0;
  const limit = Number(limits[key]);
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.max(0, Math.min(100, (Number(value) / limit) * 100));
}

function renderStabilityStressDialog(): HTMLElement {
  const metric = (label: string, key: string, unit: string) => el('div', { class: 'stability-stress-metric' }, [
    el('div', { class: 'stability-stress-metric-label', text: label }),
    el('div', { class: 'stability-stress-metric-value' }, [
      el('span', { dataset: { stabilityStressValue: key }, text: '—' }),
      el('small', { text: unit }),
    ]),
    el('div', { class: 'stability-stress-spark', dataset: { stabilityStressSpark: key } }),
  ]);
  const dialog = el('section', {
    class: 'stability-stress-dialog',
    role: 'dialog',
    'aria-modal': 'false',
    'aria-label': 'Arc Power stability test',
    hidden: true,
    dataset: { stabilityStressDialog: 'true', dismissed: 'false' },
  }, [
    el('header', { class: 'stability-stress-header' }, [
      el('div', { class: 'stability-stress-title', dataset: { stabilityStressTitle: 'true' }, text: 'Stress Test' }),
      el('button', { class: 'stability-stress-close', type: 'button', title: 'Close results', 'aria-label': 'Close stability test results', dataset: { stabilityStressClose: 'true' }, text: '×' }),
    ]),
    el('div', { class: 'stability-stress-grid' }, [
      metric('GPU Clock Speed', 'gpuClockMhz', 'MHz'),
      metric('VRAM Clock Speed', 'vramClockMhz', 'MHz'),
      metric('Power Consumption', 'powerW', 'W'),
      metric('Fan Speed', 'fanRpm', 'RPM'),
      metric('VRAM Temperature', 'vramTempC', '°C'),
      metric('Current Temperature', 'currentTempC', '°C'),
      metric('GPU Utilization', 'gpuUtilPct', '%'),
      metric('VRAM In Use', 'vramUsedBytes', ''),
    ]),
    el('div', { class: 'stability-stress-footer' }, [
      el('div', { class: 'stability-stress-result', dataset: { stabilityStressResult: 'true' }, text: 'Starting stress test' }),
      el('div', { class: 'stability-stress-whea', dataset: { stabilityStressWhea: 'true' }, text: 'WHEA check starting…' }),
      el('button', { class: 'btn btn-danger stability-stress-stop', type: 'button', dataset: { stabilityStressStop: 'true' }, text: 'Stop Testing' }),
    ]),
  ]);
  return dialog;
}

function updateStabilityStressDialog(root: HTMLElement, state: AppState): void {
  const dialog = root.querySelector<HTMLElement>('[data-stability-stress-dialog]');
  const run = state.stabilityRun;
  if (!dialog || !run) return;
  const active = run.state === 'running';
  // The dialog node is rebuilt on every tab entry. Reapply the dismissal to
  // the same completed run before rendering its result so navigation cannot
  // reopen a test the user already closed.
  if (dismissedStabilityRunId === run.runId && !active) {
    dialog.dataset.dismissed = 'true';
    dialog.hidden = true;
    return;
  }
  if (active) dialog.dataset.dismissed = 'false';
  if (dialog.dataset.dismissed === 'true' && !active) { dialog.hidden = true; return; }
  dialog.hidden = false;
  const title = dialog.querySelector<HTMLElement>('[data-stability-stress-title]');
  const result = dialog.querySelector<HTMLElement>('[data-stability-stress-result]');
  const stop = dialog.querySelector<HTMLButtonElement>('[data-stability-stress-stop]');
  const close = dialog.querySelector<HTMLButtonElement>('[data-stability-stress-close]');
  const metrics = run.metrics ?? null;
  const targetName = run.target?.name ?? 'Selected GPU';
  if (title) title.textContent = `Stress Test — ${targetName}`;
  const startMs = Date.parse(run.startedAt);
  const endMs = run.endedAt ? Date.parse(run.endedAt) : Date.now();
  const elapsed = Number.isFinite(startMs) ? Math.max(0, Math.floor((endMs - startMs) / 1000)) : 0;
  if (result) result.textContent = active
    ? `Running Stress Test   ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
    : `${stabilityOutcomeLabel(run.outcome)}   ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  // Once the run is complete this same button becomes the dismissal action.
  // Leaving it disabled made the visible "Close Results" control inert.
  if (stop) { stop.disabled = false; stop.textContent = active ? 'Stop Testing' : 'Close Results'; }
  if (close) close.hidden = active;
  const values: Record<string, string> = {
    gpuClockMhz: stressMetricText(metrics?.gpuClockMhz),
    vramClockMhz: stressMetricText(metrics?.vramClockMhz),
    powerW: stressMetricText(metrics?.powerW),
    fanRpm: stressMetricText(metrics?.fanRpm),
    vramTempC: stressMetricText(metrics?.vramTempC),
    currentTempC: stressMetricText(metrics?.currentTempC),
    gpuUtilPct: stressMetricText(metrics?.gpuUtilPct),
    vramUsedBytes: stressVramText(metrics?.vramUsedBytes),
  };
  const fallbackLimits: Record<string, number> = {
    gpuClockMhz: 3000,
    vramClockMhz: 3000,
    powerW: 252,
    fanRpm: 3000,
    vramTempC: 100,
    currentTempC: 90,
    gpuUtilPct: 100,
    vramUsedBytes: 8 * 1024 * 1024 * 1024,
  };
  const limits = { ...fallbackLimits, ...(run.limits ?? {}) };
  const rawValues: Record<string, number | null | undefined> = {
    gpuClockMhz: metrics?.gpuClockMhz,
    vramClockMhz: metrics?.vramClockMhz,
    powerW: metrics?.powerW,
    fanRpm: metrics?.fanRpm,
    vramTempC: metrics?.vramTempC,
    currentTempC: metrics?.currentTempC,
    gpuUtilPct: metrics?.gpuUtilPct,
    vramUsedBytes: metrics?.vramUsedBytes,
  };
  Object.entries(values).forEach(([key, value]) => {
    const node = dialog.querySelector<HTMLElement>(`[data-stability-stress-value="${key}"]`);
    if (node) node.textContent = value;
    const spark = dialog.querySelector<HTMLElement>(`[data-stability-stress-spark="${key}"]`);
    if (spark) spark.style.setProperty('--stress-fill', `${stressMetricFill(key, rawValues[key], limits)}%`);
  });
  const whea = run.whea;
  const wheaNode = dialog.querySelector<HTMLElement>('[data-stability-stress-whea]');
  if (wheaNode) {
    wheaNode.dataset.outcome = whea?.errorCount ? 'error' : whea?.available ? 'ok' : 'unknown';
    wheaNode.textContent = whea?.errorCount
      ? `WHEA: ${whea.errorCount} error${whea.errorCount === 1 ? '' : 's'} found`
      : whea?.available ? 'WHEA: no errors found' : `WHEA: ${whea?.error ?? 'check unavailable'}`;
  }
}

function updateStabilityLabPanel(root: HTMLElement, state: AppState): void {
  const run = state.stabilityRun;
  const report = state.stabilityReports.at(-1) ?? null;
  const status = root.querySelector<HTMLElement>('[data-stability-status]');
  const counters = root.querySelector<HTMLElement>('[data-stability-counters]');
  const note = root.querySelector<HTMLElement>('[data-stability-note]');
  const start = root.querySelector<HTMLButtonElement>('[data-stability-start]');
  const cancel = root.querySelector<HTMLButtonElement>('[data-stability-cancel]');
  const active = run?.state === 'running';
  if (status) {
    status.textContent = active ? 'Running' : stabilityOutcomeLabel(run?.outcome ?? report?.outcome ?? null);
    status.dataset.outcome = run?.outcome ?? report?.outcome ?? 'ready';
  }
  if (counters) counters.textContent = run ? `${run.sampleCount} samples · ${run.freshSampleCount} fresh · ${run.workloadEvidence ? 'GPU workload active' : run.workloadStatus === 'unavailable' ? 'workload unavailable' : run.workloadStatus === 'monitor-only' ? 'monitoring only' : run.workloadStatus === 'running' ? 'workload started · waiting for GPU utilization' : 'starting GPU workload'}` : report ? `${report.sampleCount} samples · ${report.workloadEvidence ? 'workload evidence' : 'no workload evidence'}` : 'No run yet';
  if (note) {
    note.textContent = run?.reason
      ?? (run?.workloadStatus === 'unavailable' ? `GPU workload unavailable: ${run.workloadReason ?? 'the selected adapter could not be opened'}`
        : run?.workloadStatus === 'monitor-only' ? 'Monitoring the selected GPU without a built-in workload.'
          : run?.workloadStatus === 'running' ? (run.workloadEvidence ? `GPU workload active on ${run.target?.name ?? 'the selected GPU'}.` : `Workload started on ${run.target?.name ?? 'the selected GPU'}; waiting for utilization telemetry.`)
            : report?.reason ?? 'Runs stay tied to the selected physical GPU.');
  }
  if (start) start.disabled = active;
  if (cancel) cancel.disabled = !active;
  updateStabilityStressDialog(root, state);
}

function renderStabilityLabPanel(state: AppState, ctx: PageContext): HTMLElement {
  const selected = state.devices.find((device) => device.id === state.deviceId) ?? state.devices[0] ?? null;
  const select = el('select', { class: 'stability-lab-device', 'aria-label': 'Stability Lab GPU' }, state.devices.map((device) => el('option', { value: device.deviceKey ?? deviceHardwareKey(device), text: shortGpuName(device) })));
  if (selected) select.value = selected.deviceKey ?? deviceHardwareKey(selected);
  const cadence = el('input', { class: 'stability-lab-cadence', type: 'number', min: '250', max: '2000', step: '50', value: '500', 'aria-label': 'Sampling interval in milliseconds' }) as HTMLInputElement;
  const duration = el('input', { class: 'stability-lab-duration', type: 'number', min: '10', max: '900', step: '10', value: '30', 'aria-label': 'Run duration in seconds' }) as HTMLInputElement;
  const start = el('button', { class: 'btn btn-primary', type: 'button', text: 'Start run', dataset: { stabilityStart: 'true' } }) as HTMLButtonElement;
  const cancel = el('button', { class: 'btn btn-secondary', type: 'button', text: 'Cancel', dataset: { stabilityCancel: 'true' } }) as HTMLButtonElement;
  const stressDialog = renderStabilityStressDialog();
  const root = el('section', { class: 'card stability-lab-panel', dataset: { stabilityLab: 'true' } }, [
    el('div', { class: 'telemetry-section-heading' }, [
      el('div', {}, [el('h2', { class: 'card-title', text: 'Stability Lab' }), el('p', { class: 'card-note', text: 'Runs a bounded workload on the selected GPU while sampling telemetry.' })]),
      el('span', { class: 'telemetry-live-badge', dataset: { stabilityStatus: 'true' }, text: 'Ready' }),
    ]),
    el('div', { class: 'stability-lab-controls' }, [
      el('label', { text: 'GPU' }, [select]),
      el('label', { text: 'Interval (ms)' }, [cadence]),
      el('label', { text: 'Duration (s)' }, [duration]),
      el('div', { class: 'stability-lab-actions' }, [start, cancel]),
    ]),
    el('p', { class: 'card-note', dataset: { stabilityCounters: 'true' }, text: 'No run yet' }),
    el('p', { class: 'card-note', dataset: { stabilityNote: 'true' }, text: 'Runs stay tied to the selected physical GPU.' }),
    stressDialog,
  ]);
  start.addEventListener('click', async () => {
    start.disabled = true;
    try {
      const nextRun = await api.stabilityRunStart({ deviceKey: select.value, cadenceMs: Number(cadence.value), durationSec: Number(duration.value) });
      dismissedStabilityRunId = null;
      ctx.store.set({ stabilityRun: nextRun });
    }
    catch (error) { const node = root.querySelector<HTMLElement>('[data-stability-note]'); if (node) node.textContent = error instanceof Error ? error.message : String(error); }
    finally { updateStabilityLabPanel(root, ctx.store.get()); }
  });
  cancel.addEventListener('click', async () => {
    const runId = ctx.store.get().stabilityRun?.runId;
    if (!runId) return;
    cancel.disabled = true;
    try { await api.stabilityRunCancel(runId); }
    catch (error) { const node = root.querySelector<HTMLElement>('[data-stability-note]'); if (node) node.textContent = error instanceof Error ? error.message : String(error); }
  });
  stressDialog.querySelector<HTMLButtonElement>('[data-stability-stress-stop]')?.addEventListener('click', async () => {
    const current = ctx.store.get().stabilityRun;
    const runId = current?.runId;
    if (!runId) return;
    if (current?.state !== 'running') {
      dismissedStabilityRunId = runId;
      stressDialog.dataset.dismissed = 'true';
      stressDialog.hidden = true;
      return;
    }
    try { await api.stabilityRunCancel(runId); }
    catch (error) {
      const node = stressDialog.querySelector<HTMLElement>('[data-stability-stress-result]');
      if (node) node.textContent = error instanceof Error ? error.message : String(error);
    }
  });
  stressDialog.querySelector<HTMLButtonElement>('[data-stability-stress-close]')?.addEventListener('click', () => {
    const runId = ctx.store.get().stabilityRun?.runId;
    if (runId) dismissedStabilityRunId = runId;
    stressDialog.dataset.dismissed = 'true';
    stressDialog.hidden = true;
  });
  updateStabilityLabPanel(root, state);
  return root;
}

function renderMonitoringView(container: HTMLElement, ctx: PageContext): void {
  const m = mon;
  if (!m) return;
  clearMonitoringGraphBindings();
  clear(container);
  const s = ctx.store.get();
  refreshMonitoringGraphCeilings(s);
  m.metricCanvases = new Map();
  m.rangeNodes = new Map();
  m.metricGraphs = new Map();
  m.metricBindings = [];
  m.fpsBindings = [];
  const fpsNote = el('p', { class: 'card-note mon-fps-note', text: FPS_CHECKING_NOTE });
  m.fpsNote = fpsNote;

  const monitoringSummary = el('div', { class: 'monitoring-summary-strip' }, [
    el('div', { class: 'monitoring-summary-live' }, [el('span', { class: 'status-dot status-ok' }), el('strong', { text: 'Live telemetry' })]),
    el('span', { class: 'monitoring-summary-note', text: 'Live values with compact rolling history' }),
  ]);

  const panels = el('div', { class: 'telemetry-metrics' });
  panels.append(
    telemetryPanel('fps', 'FPS & frame pacing', 'Present data', [
      fpsMetricNode('Frame rate', 'fps', 'FPS'),
      fpsMetricNode('Frame time', 'frame-time', 'ms'),
      fpsMetricNode('Average', 'average', 'FPS'),
      fpsMetricNode('1% low', 'low-1', 'FPS'),
      fpsMetricNode('0.1% low', 'low-01', 'FPS'),
      fpsMetricNode('P99', 'p99', 'FPS'),
    ], true, 'mon-readout-fps'),
    telemetryPanel('cpu', 'CPU', 'System', cpuMetricNodes(s), true, 'mon-readout-cpu'),
    telemetryPanel('system-memory', 'System memory', 'System', systemMetricNodes(s), true, 'mon-readout-system-memory'),
  );
  const appendGpuPair = (device: DeviceInfo | null, index: number, badge: string): void => {
    const label = `GPU ${index + 1}`;
    const gpuPanel = telemetryPanel(`gpu-${device?.id ?? 'vendor'}`, label, badge, gpuMetricNodes(device, s), true, index === 0 ? 'mon-readout-gpu' : `mon-readout-gpu-${index + 1}`);
    const memoryPanel = telemetryPanel(`gpu-memory-${device?.id ?? 'vendor'}`, `${label} memory`, badge, gpuMemoryMetricNodes(device, s), true, index === 0 ? 'mon-readout-gpu-memory' : `mon-readout-gpu-memory-${index + 1}`);
    panels.append(el('div', { class: 'telemetry-gpu-pair', dataset: { telemetryGpuPair: String(device?.id ?? 'vendor') } }, [gpuPanel, memoryPanel]));
  };
  dashboardGpuOrder(s.devices).forEach((device, index) => {
    appendGpuPair(device, index, shortGpuName(device));
  });
  if (s.devices.length === 0 && s.osGpu) {
    const badge = shortGpuNameFromName(s.osGpu.name);
    appendGpuPair(null, 0, badge);
  }
  m.fpsTileValue = panels.querySelector('.mon-fps-tile .stat-value') as HTMLElement;

  const readout = el('section', { class: 'card telemetry-metrics-card' }, [
    el('div', { class: 'telemetry-section-heading' }, [
      el('div', {}, [el('h2', { class: 'card-title', text: 'Metrics' }), el('p', { class: 'card-note', text: 'Choose a section to expand its complete live readout.' })]),
      el('span', { class: 'telemetry-live-badge', text: `${s.devices.length} GPU${s.devices.length === 1 ? '' : 's'}` }),
    ]),
    panels,
    fpsNote,
  ]);

  const workspace = el('div', { class: 'monitoring-workspace' }, [
    el('main', { class: 'monitoring-metrics-column' }, [monitoringSummary, renderStabilityLabPanel(s, ctx), readout]),
    renderTrackingPanel(s),
  ]);
  container.append(workspace);
  const metricsColumn = workspace.querySelector<HTMLElement>('.monitoring-metrics-column');
  if (metricsColumn && typeof ResizeObserver !== 'undefined') {
    monitoringResizeObserver = new ResizeObserver(() => redrawAll(true));
    monitoringResizeObserver.observe(metricsColumn);
  }
  redrawAll(true);
}

function redrawAll(force = false): void {
  if (!mon || monView !== 'monitoring' || mon.metricCanvases.size === 0) return;
  if (force) mon.fullRedrawPending = true;
  if (!mon.fullRedrawPending && mon.dirtySeries.size === 0) return;
  if (graphRedrawFrame !== null) return;
  // A telemetry push is emitted once per adapter, so a multi-GPU machine can
  // deliver multiple store updates in one paint interval. Coalesce those
  // updates into one frame so graphs never render an intermediate snapshot.
  graphRedrawFrame = window.requestAnimationFrame(() => {
    graphRedrawFrame = null;
    if (!mon || monView !== 'monitoring') return;
    const drawAll = mon.fullRedrawPending;
    mon.fullRedrawPending = false;
    const dirty = drawAll ? new Set(mon.metricCanvases.keys()) : new Set(mon.dirtySeries);
    mon.dirtySeries.clear();
    if (dirty.size === 0) return;
    const accentColor = cssVar('--accent');
    for (const id of dirty) {
      const canvas = mon.metricCanvases.get(id);
      if (!canvas) continue;
      const range = drawMiniSeries(canvas, mon.series[id] ?? [], id, monitoringSeriesColor(id, accentColor), mon.graphCeilings.get(id));
      const nodes = mon.rangeNodes.get(id);
      if (nodes) {
        nodes.min.textContent = range ? graphRangeValue(id, range.min) : '—';
        nodes.max.textContent = range ? graphRangeValue(id, range.max) : '—';
      }
      updateMetricGraphOverlay(id, range);
    }
  });
}

/**
 * 1.0.1 (N9): redraw the canvases NOW - a theme switch recolors the graphs
 * immediately (drawMiniSeries reads the CSS vars at draw time; without this
 * hook the graphs would keep the old palette until the next telemetry
 * tick). No-op when the Monitoring page is not mounted.
 */
export function redrawMonitoringGraphs(): void {
  redrawAll(true);
}
