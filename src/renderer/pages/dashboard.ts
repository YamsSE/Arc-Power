// Arc Power - Dashboard page (M2b-B redesign + M3-A + M3-C-I): GPU card
// (M4-H: title 'GPU' + a 'GPU' name kv row - the Driver version row moved
// OUT (the health card keeps it); Xe cores + shader units, bundled clocks
// row, standalone ReBAR pill - M2C-B B2), the general GPU Status card (five
// honest rows: driver installed, device detected, OC working, OC waiver -
// the ONLY persistent waiver display (M4-A correction), Arc Power
// working), the CPU & Memory card (M4-D2 - M4-H: DDR5 memory type + the
// blue .kv-static-freq GHz speed span + the M4J Mainboard row), and a
// compact System Snapshot (the Performance Pulse above owns live telemetry;
// this card keeps the bottom of the page useful for context and actions).
//
// The page re-renders fully only when a status slot changes (boot probe,
// boot errors); telemetry ticks refresh the live cards in place - no
// per-tick DOM churn (the decision lives in pure/status.ts::
// dashboardNeedsFullRender, unit-tested).

import { el, clear, svgEl } from '../dom.ts';
import type { AppState, Page, PageContext } from '../router.ts';
import { healthRows, dashboardNeedsFullRender } from '../pure/status.ts';
import type { DashboardSig, HealthRow } from '../pure/status.ts';
import { ensureWaiver } from '../components/waiver-dialog.ts';
import { shaderUnits } from '../pure/driver.ts';
import { cpuCardRows, rebarState, vramRowValue } from '../pure/sysinfo.ts';
import { formatGpuMemoryGb } from '../pure/gpu-memory.ts';
import { cpuIconKeyOf, cpuIconPath, gpuIconKeyOf, gpuIconPath } from '../pure/hardware-icons.ts';
import { deviceHardwareKey } from '../pure/device.ts';
import { dashboardDeviceStatusLabel, dashboardGpuOrder } from '../pure/dashboard.ts';
import { aibOf, aibOfPnpDeviceId } from '../pure/aib.ts';
import { api } from '../ipc.ts';
import { toast } from '../components/toast.ts';
import type { ProfilesEnvelope, RecordingClip, RecordingSettings, RecordingStorageInfo, TelemetrySample } from '../types.ts';
import { TELEMETRY_HISTORY_POINTS, TELEMETRY_PULSE_COLORS } from '../pure/telemetry-visuals.ts';
import { nearestSampleIndex } from '../pure/graph.ts';
import type { SeriesPoint } from '../pure/graph.ts';
import {
  clampGraphTooltipPosition,
  graphDrawnPoints,
  graphSamplePosition,
  monitoringGraphRangeForMax,
} from '../pure/monitoring-graph.ts';

/** M4-D2 (§6): the "Cores / clock" bundled row's LIVE half - the current
 *  CPU frequency from the telemetry tick, ALWAYS in GHz with 1 decimal
 *  (" / @ 4.3 GHz" - the leading separator joins the static cores/threads
 *  half); null sample -> honest '-' (never a fake number). */
function liveFreqText(sample: TelemetrySample | null): string {
  const mhz = sample?.cpuFreqMhz;
  if (typeof mhz !== 'number' || !Number.isFinite(mhz)) return ' / @ - GHz';
  return ` / @ ${(mhz / 1000).toFixed(1)} GHz`;
}

/** M17c: the Board partner row value - '<AIB vendor> (<model>)' from the
 *  caps AIB fields; unknown (both null) -> '-' (the honest grey). */
function boardPartnerText(caps: { aibVendor?: string | null; aibModel?: string | null } | null | undefined): string {
  const vendor = caps?.aibVendor;
  if (!vendor) return '-';
  const model = caps?.aibModel;
  return model ? `${vendor} (${model})` : vendor;
}

/** M17d: the no-Intel Clocks row text - LIVE from the vendor lane sample
 *  (NVML clock graphics = gpuClockMhz + NVML_CLOCK_MEM = memClockMhz) once a
 *  tick reports; the honest static '- MHz Core / - MHz Memory' before the
 *  first tick / when the lane has no source. */
function noIntelClocksText(sample: TelemetrySample | null): string {
  const core = sample?.gpuClockMhz;
  const mem = sample?.memClockMhz;
  const coreText = typeof core === 'number' && Number.isFinite(core) ? core : '-';
  const memText = typeof mem === 'number' && Number.isFinite(mem) ? mem : '-';
  return `${coreText} MHz Core / ${memText} MHz Memory`;
}

function statValue(v: number | null | undefined, decimals = 0): string {
  return v === undefined || v === null || !Number.isFinite(v) ? '-' : decimals > 0 ? v.toFixed(decimals) : String(Math.round(v));
}

type DashboardPulseId = 'gpu-util' | 'temperature' | 'power' | 'vram';

const DASHBOARD_PULSE: Array<{ id: DashboardPulseId; label: string; unit: string; color: string }> = [
  { id: 'gpu-util', label: 'GPU utilization', unit: '%', color: TELEMETRY_PULSE_COLORS.utilization },
  { id: 'temperature', label: 'GPU temperature', unit: '°C', color: TELEMETRY_PULSE_COLORS.temperature },
  { id: 'power', label: 'GPU power', unit: 'W', color: TELEMETRY_PULSE_COLORS.power },
  { id: 'vram', label: 'VRAM in use', unit: 'GB', color: TELEMETRY_PULSE_COLORS.memory },
];

const DASHBOARD_HISTORY_LIMIT = TELEMETRY_HISTORY_POINTS;
type DashboardPulseLane = {
  key: string;
  history: TelemetrySample[];
  startedAt: number;
  valueNodes: Map<DashboardPulseId, HTMLElement>;
  pathNodes: Map<DashboardPulseId, SVGPathElement>;
  rangeMinNodes: Map<DashboardPulseId, HTMLElement>;
  rangeMaxNodes: Map<DashboardPulseId, HTMLElement>;
  axisMinNodes: Map<DashboardPulseId, HTMLElement>;
  axisMaxNodes: Map<DashboardPulseId, HTMLElement>;
  graphSurfaceNodes: Map<DashboardPulseId, HTMLElement>;
  crosshairNodes: Map<DashboardPulseId, HTMLElement>;
  hoverNodes: Map<DashboardPulseId, HTMLElement>;
  pointerRatios: Map<DashboardPulseId, number | null>;
  graphCeilings: Map<DashboardPulseId, number>;
  runtimeNode: HTMLElement | null;
  peakNode: HTMLElement | null;
  averageNode: HTMLElement | null;
};
const dashboardPulseLanes = new Map<string, DashboardPulseLane>();
type DashboardControlId = 'profile' | 'capture' | 'last' | 'storage' | 'replay';
type DashboardControlLevel = 'ok' | 'warn' | 'error' | 'unknown' | 'recording' | 'replay';
type DashboardControlDatum = { value: string; note: string; level?: DashboardControlLevel };
const controlValueNodes = new Map<DashboardControlId, HTMLElement>();
const controlNoteNodes = new Map<DashboardControlId, HTMLElement>();
let controlCaptureDotNode: HTMLElement | null = null;
type DashboardCaptureActionKind = 'recording' | 'replay';
const controlCaptureActionNodes = new Map<DashboardCaptureActionKind, { button: HTMLButtonElement; label: HTMLElement; note: HTMLElement }>();
let dashboardCaptureActionBusy = false;
let controlCenterContext: PageContext | null = null;
let controlCenterLoadPromise: Promise<void> | null = null;
let controlCenterRefreshTimer: ReturnType<typeof setInterval> | null = null;
let controlCenterGeneration = 0;
let controlCenterRemote: {
  profiles: ProfilesEnvelope | null;
  clips: RecordingClip[] | null;
  recordingSettings: RecordingSettings | null;
  storage: RecordingStorageInfo | null;
} = { profiles: null, clips: null, recordingSettings: null, storage: null };

function dashboardDeviceKey(device: { id: number; deviceKey?: string; pciVendorId: string; pciDeviceId: string; bdf: { bus: number; device: number; function: number } }): string {
  return device.deviceKey ?? deviceHardwareKey(device);
}

function dashboardSampleFor(state: AppState, device: { id: number; deviceKey?: string; pciVendorId: string; pciDeviceId: string; bdf: { bus: number; device: number; function: number } }): TelemetrySample | null {
  const key = dashboardDeviceKey(device);
  return state.latestSamples?.[key] ?? (state.deviceId === device.id ? state.latestSample : null);
}

function pulseLaneFor(key: string): DashboardPulseLane {
  const existing = dashboardPulseLanes.get(key);
  if (existing) return existing;
  const created: DashboardPulseLane = {
    key,
    history: [],
    startedAt: Date.now(),
    valueNodes: new Map(),
    pathNodes: new Map(),
    rangeMinNodes: new Map(),
    rangeMaxNodes: new Map(),
    axisMinNodes: new Map(),
    axisMaxNodes: new Map(),
    graphSurfaceNodes: new Map(),
    crosshairNodes: new Map(),
    hoverNodes: new Map(),
    pointerRatios: new Map(),
    graphCeilings: new Map(),
    runtimeNode: null,
    peakNode: null,
    averageNode: null,
  };
  dashboardPulseLanes.set(key, created);
  return created;
}

function rememberDashboardSample(lane: DashboardPulseLane, sample: TelemetrySample | null): void {
  if (!sample) return;
  const last = lane.history[lane.history.length - 1];
  if (last && last.t === sample.t && last.deviceKey === sample.deviceKey) return;
  const next = [...lane.history, sample];
  // Telemetry normally arrives in timestamp order. Preserve that cheap path,
  // while retaining chronological nearest-sample behavior if a late sample
  // arrives after a renderer or driver hiccup.
  lane.history = last && sample.t < last.t
    ? next.sort((a, b) => a.t - b.t).slice(-DASHBOARD_HISTORY_LIMIT)
    : next.slice(-DASHBOARD_HISTORY_LIMIT);
}

function pulseSampleValue(id: DashboardPulseId, sample: TelemetrySample): number | undefined {
  if (id === 'gpu-util') return sample.gpuUtilPct ?? sample.utilPct;
  if (id === 'temperature') return sample.tempC;
  if (id === 'power') return sample.powerW;
  return typeof sample.gpuMemUsedBytes === 'number' && Number.isFinite(sample.gpuMemUsedBytes)
    ? sample.gpuMemUsedBytes / 1e9
    : undefined;
}

function pulseDisplayValue(id: DashboardPulseId, sample: TelemetrySample | null): string {
  const value = sample ? pulseSampleValue(id, sample) : undefined;
  return id === 'power' ? statValue(value, 1) : id === 'vram' ? (value === undefined ? '-' : value.toFixed(1)) : statValue(value);
}

function pulseHistoryValues(lane: DashboardPulseLane, id: DashboardPulseId): number[] {
  return lane.history
    .map((sample) => pulseSampleValue(id, sample))
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function pulseHistoryPoints(lane: DashboardPulseLane, id: DashboardPulseId): SeriesPoint[] {
  return lane.history
    .map((sample) => ({ t: sample.t, v: pulseSampleValue(id, sample) }))
    .filter((point): point is SeriesPoint => Number.isFinite(point.t) && Number.isFinite(point.v));
}

function pulseObservedRange(points: SeriesPoint[]): { min: number; max: number } | null {
  if (points.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    if (point.v < min) min = point.v;
    if (point.v > max) max = point.v;
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

function pulseGraphSeriesId(id: DashboardPulseId): string {
  if (id === 'gpu-util') return 'util';
  if (id === 'temperature') return 'temp';
  return id;
}

function setDashboardGraphCeiling(lane: DashboardPulseLane, id: DashboardPulseId, value: number | null | undefined): void {
  if (!Number.isFinite(value) || Number(value) <= 0) return;
  const previous = lane.graphCeilings.get(id) ?? 0;
  if (Number(value) > previous) lane.graphCeilings.set(id, Number(value));
}

function setDashboardVramCapacity(lane: DashboardPulseLane, vramBytes: number | null | undefined, sharedMemoryBytes?: number | null): void {
  const capacityBytes = vramBytes ?? sharedMemoryBytes;
  if (!Number.isFinite(capacityBytes) || Number(capacityBytes) <= 0) return;
  setDashboardGraphCeiling(lane, 'vram', Number(capacityBytes) / 1e9);
}

function pulseRangeValue(id: DashboardPulseId, value: number): string {
  if (id === 'power' || id === 'vram') return value.toFixed(1);
  return String(Math.round(value));
}

function updatePulsePath(lane: DashboardPulseLane, id: DashboardPulseId): void {
  const path = lane.pathNodes.get(id);
  if (!path) return;
  const points = pulseHistoryPoints(lane, id);
  const observed = pulseObservedRange(points);
  const minNode = lane.rangeMinNodes.get(id);
  const maxNode = lane.rangeMaxNodes.get(id);
  const axisMinNode = lane.axisMinNodes.get(id);
  const axisMaxNode = lane.axisMaxNodes.get(id);
  const axisRange = monitoringGraphRangeForMax(pulseGraphSeriesId(id), observed?.max, lane.graphCeilings.get(id));
  if (!observed || !axisRange) {
    if (minNode) minNode.textContent = '—';
    if (maxNode) maxNode.textContent = '—';
    if (axisMinNode) axisMinNode.hidden = true;
    if (axisMaxNode) axisMaxNode.hidden = true;
    lane.crosshairNodes.get(id)?.setAttribute('hidden', 'true');
    lane.hoverNodes.get(id)?.setAttribute('hidden', 'true');
    path.setAttribute('d', 'M 0 16 L 120 16');
    return;
  }
  if (minNode) minNode.textContent = pulseRangeValue(id, observed.min);
  if (maxNode) maxNode.textContent = pulseRangeValue(id, observed.max);
  if (axisMinNode) {
    axisMinNode.textContent = pulseRangeValue(id, axisRange.min);
    axisMinNode.hidden = false;
  }
  if (axisMaxNode) {
    axisMaxNode.textContent = pulseRangeValue(id, axisRange.max);
    axisMaxNode.hidden = false;
  }
  const drawn = graphDrawnPoints(points);
  if (drawn.length < 2) {
    const position = graphSamplePosition(drawn, 0, 120, 32, axisRange, 4, 22);
    const y = position?.y ?? 16;
    path.setAttribute('d', `M 0 ${y.toFixed(1)} L 120 ${y.toFixed(1)}`);
  } else {
    const pathPoints = drawn.map((_, index) => graphSamplePosition(drawn, index, 120, 32, axisRange, 4, 22));
    const pathData = pathPoints
      .filter((point): point is { x: number; y: number } => point !== null)
      .map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`);
    path.setAttribute('d', pathData.length > 0 ? `M ${pathData.join(' L ')}` : 'M 0 16 L 120 16');
  }
  const surface = lane.graphSurfaceNodes.get(id);
  const crosshair = lane.crosshairNodes.get(id);
  const hover = lane.hoverNodes.get(id);
  const pointerRatio = lane.pointerRatios.get(id) ?? null;
  if (!surface || !crosshair || !hover || pointerRatio === null || drawn.length === 0) {
    if (crosshair) crosshair.hidden = true;
    if (hover) hover.hidden = true;
    return;
  }
  const index = nearestSampleIndex(drawn, pointerRatio);
  if (index < 0) {
    crosshair.hidden = true;
    hover.hidden = true;
    return;
  }
  const rect = surface.getBoundingClientRect();
  const width = surface.clientWidth || rect.width;
  const height = surface.clientHeight || rect.height;
  const position = graphSamplePosition(drawn, index, width, height, axisRange, 2, Math.max(4, height - 4));
  if (!position) {
    crosshair.hidden = true;
    hover.hidden = true;
    return;
  }
  crosshair.style.left = `${position.x}px`;
  crosshair.hidden = false;
  hover.textContent = pulseRangeValue(id, drawn[index].v);
  hover.hidden = false;
  const textWidth = hover.offsetWidth || 28;
  const textHeight = hover.offsetHeight || 10;
  const hoverPosition = clampGraphTooltipPosition(position.x, position.y, width, height, textWidth, textHeight);
  hover.style.left = `${hoverPosition.left}px`;
  hover.style.top = `${hoverPosition.top}px`;
}

function formatSessionAge(startedAt: number): string {
  const totalSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, '0')}m`
    : `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function updateSessionStats(lane: DashboardPulseLane): void {
  const temps = pulseHistoryValues(lane, 'temperature');
  const utils = pulseHistoryValues(lane, 'gpu-util');
  if (lane.runtimeNode) lane.runtimeNode.textContent = formatSessionAge(lane.startedAt);
  if (lane.peakNode) lane.peakNode.textContent = temps.length ? `${Math.round(Math.max(...temps))} °C` : '-';
  if (lane.averageNode) lane.averageNode.textContent = utils.length
    ? `${Math.round(utils.reduce((sum, value) => sum + value, 0) / utils.length)} %`
    : '-';
}

function updatePulseLane(lane: DashboardPulseLane, sample: TelemetrySample | null): void {
  rememberDashboardSample(lane, sample);
  for (const metric of DASHBOARD_PULSE) {
    const valueNode = lane.valueNodes.get(metric.id);
    if (valueNode) valueNode.textContent = pulseDisplayValue(metric.id, sample);
    setDashboardGraphCeiling(lane, metric.id, sample ? pulseSampleValue(metric.id, sample) : undefined);
    updatePulsePath(lane, metric.id);
  }
  updateSessionStats(lane);
}

function pulseLaneElement(
  lane: DashboardPulseLane,
  gpuLabel: string,
  gpuName: string,
  sample: TelemetrySample | null,
): HTMLElement {
  lane.valueNodes.clear();
  lane.pathNodes.clear();
  lane.rangeMinNodes.clear();
  lane.rangeMaxNodes.clear();
  lane.axisMinNodes.clear();
  lane.axisMaxNodes.clear();
  lane.graphSurfaceNodes.clear();
  lane.crosshairNodes.clear();
  lane.hoverNodes.clear();
  const pulseCards = DASHBOARD_PULSE.map((metric) => {
    const path = svgEl('path', {
      d: 'M 0 16 L 120 16',
      fill: 'none',
      stroke: metric.color,
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }) as SVGPathElement;
    const svg = svgEl('svg', {
      class: 'dashboard-sparkline',
      viewBox: '0 0 120 32',
      role: 'img',
      'aria-label': `${gpuLabel} ${metric.label} history`,
    });
    svg.append(path);
    const valueNode = el('strong', { class: 'dashboard-pulse-value', text: pulseDisplayValue(metric.id, sample) });
    lane.valueNodes.set(metric.id, valueNode);
    lane.pathNodes.set(metric.id, path);
    const rangeMinNode = el('strong', { text: '—' });
    const rangeMaxNode = el('strong', { text: '—' });
    lane.rangeMinNodes.set(metric.id, rangeMinNode);
    lane.rangeMaxNodes.set(metric.id, rangeMaxNode);
    const axisMaxNode = el('span', { class: 'dashboard-sparkline-axis-label dashboard-sparkline-axis-y dashboard-sparkline-axis-y-max', hidden: true });
    const axisMinNode = el('span', { class: 'dashboard-sparkline-axis-label dashboard-sparkline-axis-y dashboard-sparkline-axis-y-min', hidden: true });
    const crosshair = el('span', { class: 'dashboard-sparkline-crosshair', hidden: true, 'aria-hidden': 'true' });
    const hover = el('span', { class: 'dashboard-sparkline-hover', hidden: true, role: 'status' });
    const grid = el('div', { class: 'dashboard-sparkline-grid', 'aria-hidden': 'true' }, [
      el('span', { class: 'dashboard-sparkline-grid-line dashboard-sparkline-grid-h dashboard-sparkline-grid-top' }),
      el('span', { class: 'dashboard-sparkline-grid-line dashboard-sparkline-grid-h dashboard-sparkline-grid-mid' }),
      el('span', { class: 'dashboard-sparkline-grid-line dashboard-sparkline-grid-h dashboard-sparkline-grid-bottom' }),
      el('span', { class: 'dashboard-sparkline-grid-line dashboard-sparkline-grid-v dashboard-sparkline-grid-left' }),
      el('span', { class: 'dashboard-sparkline-grid-line dashboard-sparkline-grid-v dashboard-sparkline-grid-quarter' }),
      el('span', { class: 'dashboard-sparkline-grid-line dashboard-sparkline-grid-v dashboard-sparkline-grid-half' }),
      el('span', { class: 'dashboard-sparkline-grid-line dashboard-sparkline-grid-v dashboard-sparkline-grid-three-quarter' }),
      el('span', { class: 'dashboard-sparkline-grid-line dashboard-sparkline-grid-v dashboard-sparkline-grid-right' }),
    ]);
    const axisRail = el('div', { class: 'dashboard-sparkline-axis-rail', 'aria-hidden': 'true' }, [axisMaxNode, axisMinNode]);
    const surface = el('div', { class: 'dashboard-sparkline-surface', 'aria-label': `${metric.label} graph` }, [svg, grid, crosshair, hover]);
    const layout = el('div', { class: 'dashboard-sparkline-layout' }, [axisRail, surface]);
    lane.axisMaxNodes.set(metric.id, axisMaxNode);
    lane.axisMinNodes.set(metric.id, axisMinNode);
    lane.graphSurfaceNodes.set(metric.id, surface);
    lane.crosshairNodes.set(metric.id, crosshair);
    lane.hoverNodes.set(metric.id, hover);
    surface.addEventListener('pointermove', (event) => {
      const rect = surface.getBoundingClientRect();
      if (rect.width <= 0) return;
      lane.pointerRatios.set(metric.id, Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)));
      updatePulsePath(lane, metric.id);
    });
    surface.addEventListener('pointerleave', () => {
      lane.pointerRatios.set(metric.id, null);
      updatePulsePath(lane, metric.id);
    });
    const range = el('div', { class: 'dashboard-sparkline-range', 'aria-label': `${metric.label} graph range` }, [
      el('span', {}, [el('span', { class: 'dashboard-sparkline-range-label', text: 'Min' }), rangeMinNode]),
      el('span', {}, [el('span', { class: 'dashboard-sparkline-range-label', text: 'Max' }), rangeMaxNode]),
    ]);
    return el('div', { class: 'dashboard-pulse-metric', dataset: { pulseMetric: metric.id } }, [
      el('div', { class: 'dashboard-pulse-metric-head' }, [
        el('span', { class: 'dashboard-pulse-label', text: metric.label }),
        el('span', { class: 'dashboard-pulse-inline-value' }, [valueNode, el('span', { class: 'dashboard-pulse-unit', text: metric.unit })]),
      ]),
      layout,
      range,
    ]);
  });
  lane.runtimeNode = el('strong', { text: formatSessionAge(lane.startedAt) });
  lane.peakNode = el('strong', { text: '-' });
  lane.averageNode = el('strong', { text: '-' });
  const sessionStats = el('div', { class: 'dashboard-session-stats' }, [
    el('span', { class: 'dashboard-session-title', text: 'Since launch' }),
    el('span', { class: 'dashboard-session-stat' }, [el('span', { text: 'Session' }), lane.runtimeNode]),
    el('span', { class: 'dashboard-session-stat' }, [el('span', { text: 'Peak temp' }), lane.peakNode]),
    el('span', { class: 'dashboard-session-stat' }, [el('span', { text: 'Average GPU' }), lane.averageNode]),
  ]);
  updatePulseLane(lane, sample);
  return el('section', { class: 'dashboard-pulse-lane', dataset: { deviceKey: lane.key } }, [
    el('div', { class: 'dashboard-pulse-heading' }, [
      el('div', {}, [
        el('span', { class: 'dashboard-eyebrow', text: gpuLabel }),
        el('h3', { class: 'card-title', text: gpuName || 'GPU' }),
      ]),
    ]),
    el('div', { class: 'dashboard-pulse-grid' }, pulseCards),
    sessionStats,
  ]);
}

function dashboardPulse(ctx: PageContext): HTMLElement {
  const state = ctx.store.get();
  const devices = dashboardGpuOrder(state.devices);
  const entries = devices.length > 0
    ? devices.map((device, index) => ({
        device,
        label: `GPU ${index + 1}`,
        name: device.name,
        key: dashboardDeviceKey(device),
        sample: dashboardSampleFor(state, device),
      }))
    : [{ device: null, label: 'System', name: state.osGpu?.name ?? 'No GPU selected', key: 'system', sample: state.latestSample }];
  const activeKeys = new Set(entries.map((entry) => entry.key));
  for (const key of dashboardPulseLanes.keys()) {
    if (!activeKeys.has(key)) dashboardPulseLanes.delete(key);
  }
  const laneElement = (entry: typeof entries[number]): HTMLElement => {
    const lane = pulseLaneFor(entry.key);
    if (entry.device) setDashboardVramCapacity(lane, entry.device.vramBytes, entry.device.sharedMemoryBytes);
    else setDashboardVramCapacity(lane, state.osGpu?.vramBytes, state.osGpu?.sharedMemoryBytes);
    return pulseLaneElement(lane, entry.label, entry.name, entry.sample);
  };
  return el('section', { class: 'card dashboard-pulse-card' }, [
    el('div', { class: 'dashboard-pulse-heading' }, [
      el('div', {}, [
        el('span', { class: 'dashboard-eyebrow', text: 'Live telemetry' }),
        el('h2', { class: 'card-title', text: 'Performance pulse' }),
      ]),
      el('span', { class: `dashboard-pulse-device${entries.length ? '' : ' text-unknown' }`, text: `${entries.length} GPU${entries.length === 1 ? '' : 's'}` }),
    ]),
    el('div', { class: 'dashboard-pulse-lanes' }, entries.map(laneElement)),
  ]);
}

function updateDashboardPulse(ctx: PageContext): void {
  const state = ctx.store.get();
  if (state.devices.length === 0) {
    updatePulseLane(pulseLaneFor('system'), state.latestSample);
    return;
  }
  for (const device of dashboardGpuOrder(state.devices)) {
    updatePulseLane(pulseLaneFor(dashboardDeviceKey(device)), dashboardSampleFor(state, device));
  }
}

function dashboardGpuCard(device: AppState['devices'][number], index: number, state: AppState): HTMLElement {
  const sample = dashboardSampleFor(state, device);
  const rebar = rebarState(device.osController ? { rebarActive: device.osController.rebarActive } : null);
  const aib = aibOf(device.pciSubsysVendorId, device.pciSubsysId);
  const core = Number.isFinite(device.graphicsClockMHz) ? device.graphicsClockMHz : null;
  const memory = typeof sample?.memClockMhz === 'number' && Number.isFinite(sample.memClockMhz)
    ? sample.memClockMhz
    : null;
  return el('section', { class: 'card device-card', dataset: { deviceKey: dashboardDeviceKey(device) } }, [
    el('div', { class: 'device-card-head' }, [
      el('div', { class: 'hardware-card-heading' }, [
        el('h2', { class: 'card-title', text: `GPU ${index}` }),
        hardwareIcon(gpuIconPath(gpuIconKeyOf(device.name, device.gpuVendor, device)), `${device.name} icon`, 'gpu'),
      ]),
    ]),
    el('div', { class: 'card-body kv-grid' }, [
      el('div', { class: 'kv', 'data-label': 'GPU' }, [el('span', { text: device.name })]),
      el('div', { class: 'kv', 'data-label': 'Board partner' }, [el('span', {
        class: aib ? undefined : 'text-unknown',
        text: aib ? (aib.model ? `${aib.vendor} (${aib.model})` : aib.vendor) : '-',
      })]),
      el('div', { class: 'kv', 'data-label': 'Compute' }, [el('span', {
        class: device.numXeCores > 0 ? undefined : 'text-unknown',
        text: device.numXeCores > 0
          ? `Xe Cores ${device.numXeCores} - Shader Units ${shaderUnits(device.numXeCores)}`
          : '-',
      })]),
      el('div', { class: 'kv', 'data-label': 'Clocks' }, [el('span', {
        class: 'kv-clocks',
        text: `${core ?? '--'} MHz Core / ${memory ?? '--'} MHz Memory`,
      })]),
      el('div', { class: 'kv', 'data-label': 'VRAM' }, [el('span', { text: vramRowValue(device.vramBytes, device.memType) })]),
      ...(sharedMemoryBytesOf(device, null) !== null
        ? [el('div', { class: 'kv', 'data-label': 'Shared GPU Memory' }, [el('span', { text: `${formatGpuMemoryGb(sharedMemoryBytesOf(device, null))} GB` })])]
        : []),
      el('div', { class: 'kv kv-rebar' }, [
        el('span', { class: `chip rebar-pill status-${rebar.level}`, text: rebar.label }),
      ]),
    ]),
  ]);
}

type DashboardActionKind = 'recording' | 'replay' | 'tuning';

const DASHBOARD_ACTION_PATHS: Record<DashboardActionKind, string> = {
  recording: 'M8 5v14l11-7L8 5Z',
  replay: 'M20 11a8 8 0 0 0-14-4L4 9M4 5v4h4M4 13a8 8 0 0 0 14 4l2-2M20 19v-4h-4',
  tuning: 'M4 7h16M4 12h16M4 17h16',
};

function captureModeRunning(status: AppState['recordingStatus'], mode: DashboardCaptureActionKind): boolean {
  if (!status) return false;
  return mode === 'recording'
    ? status.activeModes?.video === true || (!status.activeModes && status.running === true && status.mode === 'video')
    : status.activeModes?.replay === true || (!status.activeModes && status.running === true && status.mode === 'replay');
}

function dashboardCaptureActionCopy(kind: DashboardCaptureActionKind, running: boolean): { label: string; description: string } {
  if (kind === 'recording') {
    return running
      ? { label: 'Stop Recording', description: 'Stop the current recording' }
      : { label: 'Start Recording', description: 'Start a full recording' };
  }
  return running
    ? { label: 'Stop Instant Replay', description: 'Stop Instant Replay' }
    : { label: 'Start Instant Replay', description: 'Keep the rolling buffer running' };
}

function dashboardAction(label: string, hash: string, description: string, kind: DashboardActionKind, primary = false): HTMLElement {
  const captureAction = kind === 'recording' || kind === 'replay';
  const captureMode = captureAction ? kind : null;
  const running = captureMode ? captureModeRunning(controlCenterContext?.store.get().recordingStatus ?? null, captureMode) : false;
  const copy = captureMode ? dashboardCaptureActionCopy(captureMode, running) : { label, description };
  const icon = svgEl('svg', {
    class: 'dashboard-hub-action-icon',
    viewBox: '0 0 24 24',
    'aria-hidden': 'true',
  });
  icon.append(svgEl('path', {
    d: DASHBOARD_ACTION_PATHS[kind],
    fill: kind === 'recording' ? 'currentColor' : 'none',
    stroke: kind === 'recording' ? 'none' : 'currentColor',
    'stroke-width': 1.7,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }));
  if (kind === 'tuning') {
    icon.append(
      svgEl('circle', { cx: 9, cy: 7, r: 2, fill: 'var(--bg-elev)', stroke: 'currentColor', 'stroke-width': 1.7 }),
      svgEl('circle', { cx: 15, cy: 12, r: 2, fill: 'var(--bg-elev)', stroke: 'currentColor', 'stroke-width': 1.7 }),
      svgEl('circle', { cx: 11, cy: 17, r: 2, fill: 'var(--bg-elev)', stroke: 'currentColor', 'stroke-width': 1.7 }),
    );
  }
  const action = el(captureAction ? 'button' : 'a', captureAction ? {
    class: `dashboard-hub-action dashboard-hub-action-${kind}${primary ? ' dashboard-hub-action-primary' : ''}`,
    type: 'button',
    disabled: dashboardCaptureActionBusy || controlCenterContext?.store.get().recordingStatus?.available !== true,
    title: copy.label,
    'aria-label': copy.label,
    onClick: () => void toggleDashboardCapture(captureMode as DashboardCaptureActionKind),
  } : {
    class: `dashboard-hub-action dashboard-hub-action-${kind}${primary ? ' dashboard-hub-action-primary' : ''}`,
    href: hash,
  }, [
    el('span', { class: 'dashboard-hub-action-icon-wrap' }, [icon]),
    el('span', { class: 'dashboard-hub-action-copy' }, [
      el('strong', { text: copy.label }),
      el('small', { text: copy.description }),
    ]),
    el('span', { class: 'dashboard-hub-action-arrow', text: captureAction ? '›' : '↗', 'aria-hidden': 'true' }),
  ]) as HTMLElement;
  if (captureMode) {
    const button = action as HTMLButtonElement;
    const actionCopy = action.querySelector('.dashboard-hub-action-copy');
    const labelNode = actionCopy?.querySelector('strong');
    const noteNode = actionCopy?.querySelector('small');
    if (labelNode && noteNode) controlCaptureActionNodes.set(captureMode, { button, label: labelNode as HTMLElement, note: noteNode as HTMLElement });
  }
  return action;
}

function updateDashboardCaptureActions(status: AppState['recordingStatus']): void {
  for (const [kind, nodes] of controlCaptureActionNodes) {
    const running = captureModeRunning(status, kind);
    const copy = dashboardCaptureActionCopy(kind, running);
    nodes.label.textContent = copy.label;
    nodes.note.textContent = copy.description;
    nodes.button.disabled = dashboardCaptureActionBusy || status?.available !== true;
    nodes.button.title = copy.label;
    nodes.button.setAttribute('aria-label', copy.label);
  }
}

async function toggleDashboardCapture(mode: DashboardCaptureActionKind): Promise<void> {
  const ctx = controlCenterContext;
  if (!ctx || dashboardCaptureActionBusy) return;
  const status = ctx.store.get().recordingStatus;
  if (status?.available !== true) {
    toast('error', 'Capture unavailable', 'Arc Capture is not ready yet.');
    return;
  }
  const running = captureModeRunning(status, mode);
  dashboardCaptureActionBusy = true;
  updateDashboardCaptureActions(status);
  try {
    const nextState = running
      ? await api.recordingStop(mode === 'recording' ? 'video' : 'replay')
      : mode === 'recording'
        ? (await api.recordingStart()).state
        : (await api.recordingReplayStart()).state;
    ctx.store.set({ recordingStatus: nextState });
  } catch (err) {
    toast('error', mode === 'recording' ? 'Recording failed' : 'Instant Replay failed', err instanceof Error ? err.message : String(err));
  } finally {
    dashboardCaptureActionBusy = false;
    if (controlCenterContext === ctx) updateDashboardControlCenter(ctx);
  }
}

function sharedMemoryBytesOf(
  device: { sharedMemoryBytes?: number | null; osController?: { sharedMemoryBytes?: number | null } | null } | null,
  osGpu: { sharedMemoryBytes?: number | null } | null,
): number | null {
  const bytes = device?.sharedMemoryBytes ?? device?.osController?.sharedMemoryBytes ?? osGpu?.sharedMemoryBytes;
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}

function hardwareIcon(path: string | null, alt: string, kind: 'cpu' | 'gpu'): HTMLElement | null {
  if (!path) return null;
  return el('img', {
    class: `hardware-card-icon hardware-card-icon-${kind}${path.endsWith('/intel-arc-alchemist.png') ? ' hardware-card-icon-alchemist' : ''}`,
    src: path,
    alt,
    loading: 'eager',
    decoding: 'async',
    dataset: { hardwareIcon: kind },
  });
}

/** M4-H (C3)/M4M (D)/M4N (A): the CPU group of the live readout - Util
 *  FIRST (the planned order), then Core Frequency (M4N: GHz - the shared
 *  ghzFreq helper, the mock's 4300 MHz reads '4.3'), Temperature and the
 *  Power tile (M4N: renamed from Wattage; cpuPowerW from the PowerMeter
 *  counter - the class is often absent on desktops -> honest '-'). */
/** The store slots that decide whether the dashboard must fully re-render. */
function currentSig(ctx: PageContext): DashboardSig {
  const s = ctx.store.get();
  return {
    health: s.health,
    caps: s.caps,
    bootError: s.bootError,
    driverDate: s.driverDate,
    sysinfo: s.sysinfo,
    noIntel: s.noIntel,
    osGpu: s.osGpu,
    // M17d: the vendor-lane static info (the no-Intel VRAM/Compute rows'
    // source) - a status slot (the GPU card re-renders when it lands).
    vendorInfo: s.vendorInfo,
    // M16: the device read-back - the OC status row's stock-state source
    // (an apply from any path refreshes the store state, so the row flips
    // on the re-render).
    state: s.state,
    // Device enumeration can land again after late memory enrichment. Keep
    // it in the static-card signature so the new shared-capacity row appears
    // without waiting for navigation or a telemetry tick.
    devices: s.devices,
  };
}

/** Last full-render signature (module state - telemetry ticks never touch it). */
let lastSig: DashboardSig | null = null;

/** One health row: dot (level-colored) + label + detail line. The M4-A
 *  "OC waiver" row is CLICKABLE while unaccepted (error level): the click
 *  opens the waiver dialog; on Accept the store caps are patched
 *  (waiverAccepted: true) and the dashboard's caps-change full re-render
 *  flips the row green IN PLACE. Accepted -> no click action. */
function healthRowEl(row: HealthRow, ctx: PageContext): HTMLElement {
  const stockOc = row.id === 'oc' && row.detail === 'No Overclock Applied';
  const node = el('div', { class: 'health-row', 'data-row': row.id }, [
    el('span', { class: `status-dot health-dot status-${row.level}${stockOc ? ' status-oc-stock' : ''}`, title: row.detail }),
    el('span', { class: 'health-row-label', text: row.label }),
    el('span', { class: `health-row-detail text-${row.level}${stockOc ? ' text-oc-stock' : ''}`, text: row.detail }),
  ]);
  if (row.id === 'waiver' && row.level === 'error') {
    node.classList.add('health-row-clickable');
    node.title = 'Warranty waiver not accepted - click to review and accept';
    node.addEventListener('click', () => void openWaiverFromRow(ctx));
  }
  return node;
}

/** M4-A: the dashboard waiver-row click -> the SAME dialog the apply paths
 *  use (ensureWaiver); on Accept, patch the store caps so the row flips
 *  green via the existing caps-change re-render. Cancel just closes. */
async function openWaiverFromRow(ctx: PageContext) {
  const live = ctx.store.get();
  if (live.deviceId === null || !live.caps || live.caps.waiverAccepted === true) return;
  const decision = await ensureWaiver(live.deviceId, false, live.caps.deviceName || 'this GPU');
  if (decision !== 'accepted') return;
  const cur = ctx.store.get();
  if (cur.caps && cur.caps.waiverAccepted !== true) {
    ctx.store.set({ caps: { ...cur.caps, waiverAccepted: true } });
  }
}

/** M3-A/M16: the general GPU Status card (replaces the merged Service Status
 *  card; renamed from "GPU Health" - M16). */
function healthCard(ctx: PageContext): HTMLElement {
  const s = ctx.store.get();
  const device = s.devices.find((d) => d.id === s.deviceId) ?? null;
  const osOnly = device?.synthetic === true && device.backendKind === 'os';
  const rows = dashboardHealthRows(ctx, device, osOnly);
  const devices = dashboardGpuOrder(s.devices);
  const detectionRows = devices.length > 1
    ? devices.map((gpu, index) => gpuDetectionPill(gpu, index, devices.length))
    : rows.map((row) => healthRowEl(row, ctx));

  return el('section', { class: 'card health-card' }, [
    el('h2', { class: 'card-title', text: 'GPU Status' }),
    el('div', { class: 'card-body' }, [
      ...detectionRows,
      ...(devices.length > 1 ? rows.filter((row) => row.id !== 'device').map((row) => healthRowEl(row, ctx)) : []),
    ]),
  ]);
}

function gpuDetectionPill(device: AppState['devices'][number], index: number, gpuCount: number): HTMLElement {
  return el('div', { class: 'health-row health-gpu-detection-pill', 'data-row': `device-${index + 1}` }, [
    el('span', { class: 'status-dot health-dot status-ok', title: device.name }),
    el('span', { class: 'health-row-label', text: dashboardDeviceStatusLabel(index, gpuCount) }),
    el('span', { class: 'health-row-detail text-ok', text: device.name }),
  ]);
}

function dashboardHealthRows(ctx: PageContext, device: AppState['devices'][number] | null, osOnly: boolean): HealthRow[] {
  const s = ctx.store.get();
  return healthRows({
    health: s.health,
    device,
    sample: s.latestSample,
    bootError: s.bootError,
    driverDate: s.driverDate,
    waiverAccepted: s.caps?.waiverAccepted ?? null,
    overclockingSupported: s.caps?.overclockingSupported ?? null,
    state: s.state,
    caps: s.caps,
    hasIntelGpu: !osOnly && s.noIntel !== true,
    osGpuName: s.osGpu?.name ?? null,
  });
}

function snapshotCaptureState(status: AppState['recordingStatus']): { value: string; note: string } {
  if (!status) return { value: 'Starting', note: 'Arc Capture is initializing' };
  if (status.instantReplaySave?.status === 'saving') return { value: 'Saving Instant Replay', note: 'Writing the latest moments to disk' };
  if (status.instantReplaySave?.status === 'error') return { value: 'Instant Replay failed', note: status.instantReplaySave.error ?? 'Try saving again' };
  if (status.running) {
    if (status.activeModes?.video === true && status.activeModes?.replay === true) {
      return { value: 'Recording + Instant Replay', note: 'Both capture modes are active' };
    }
    return status.mode === 'replay'
      ? { value: 'Instant Replay', note: 'Capturing the rolling clip window' }
      : { value: 'Recording', note: 'Arc Capture is active' };
  }
  if (status.available) return { value: 'Ready', note: 'Ready when you are' };
  return { value: 'Unavailable', note: 'Capture engine is unavailable' };
}

function captureStatusLevel(status: AppState['recordingStatus']): DashboardControlLevel {
  if (!status) return 'unknown';
  const videoActive = status.activeModes
    ? status.activeModes.video === true
    : status.running === true && status.mode !== 'replay';
  const replayActive = status.activeModes
    ? status.activeModes.replay === true
    : status.running === true && status.mode === 'replay';
  if (status.running && videoActive) return 'recording';
  if (status.running && replayActive) return 'replay';
  return status.available ? 'ok' : 'unknown';
}

function compactDashboardText(value: string | null | undefined, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return fallback;
  return text.length > 74 ? `${text.slice(0, 71)}…` : text;
}

function dashboardStorageText(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'Unavailable';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB free`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB free`;
  return `${Math.round(bytes / 1e3)} KB free`;
}

function newestRecordingClip(clips: RecordingClip[] | null): RecordingClip | null {
  if (!Array.isArray(clips) || clips.length === 0) return null;
  return [...clips].sort((a, b) => {
    const aTime = Date.parse(a.modifiedAt ?? a.createdAt);
    const bTime = Date.parse(b.modifiedAt ?? b.createdAt);
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  })[0] ?? null;
}

function dashboardControlCenterState(ctx: PageContext): { values: Record<DashboardControlId, DashboardControlDatum> } {
  const s = ctx.store.get();
  const activeProfileId = controlCenterRemote.profiles?.settings.activeProfileId ?? null;
  const activeProfile = controlCenterRemote.profiles?.profiles.find((profile) => profile.id === activeProfileId) ?? null;
  const capture = snapshotCaptureState(s.recordingStatus);
  const latestClip = newestRecordingClip(controlCenterRemote.clips);
  const recordingSettings = controlCenterRemote.recordingSettings;
  const storage = controlCenterRemote.storage;
  return {
    values: {
      profile: {
        value: activeProfile?.name ?? (controlCenterRemote.profiles ? 'No active profile' : 'Loading…'),
        note: activeProfile ? (controlCenterRemote.profiles?.settings.ocOnBoot ? 'Starts with Windows' : 'Manual apply') : 'Profiles are optional',
      },
      capture: { ...capture, level: captureStatusLevel(s.recordingStatus) },
      last: latestClip
        ? { value: compactDashboardText(latestClip.fileName, 'Latest capture'), note: 'Latest saved clip or recording' }
        : { value: controlCenterRemote.clips ? 'No captures yet' : 'Loading…', note: 'Saved clips and recordings' },
      storage: storage
        ? { value: dashboardStorageText(storage.freeBytes), note: compactDashboardText(storage.location, 'Recording folder') }
        : { value: 'Loading…', note: 'Recording folder space' },
      replay: recordingSettings && Number.isFinite(recordingSettings.replayLengthSec)
        ? { value: `${recordingSettings.replayLengthSec} sec`, note: 'Instant Replay duration' }
        : { value: 'Loading…', note: 'Instant Replay length' },
    },
  };
}

function dashboardControlCenter(ctx: PageContext): HTMLElement {
  controlCenterContext = ctx;
  controlValueNodes.clear();
  controlNoteNodes.clear();
  controlCaptureDotNode = null;
  controlCaptureActionNodes.clear();
  const state = dashboardControlCenterState(ctx);

  const detail = (id: Exclude<DashboardControlId, 'capture'>, label: string, className = ''): HTMLElement => {
    const item = state.values[id];
    const valueNode = el('strong', { class: 'dashboard-control-value', text: item.value, dataset: { controlValue: id } });
    const noteNode = el('span', { class: 'dashboard-control-note', text: item.note, dataset: { controlNote: id } });
    controlValueNodes.set(id, valueNode);
    controlNoteNodes.set(id, noteNode);
    return el('div', { class: `dashboard-hub-detail${className ? ` ${className}` : ''}` }, [
      el('span', { class: 'dashboard-control-label', text: label }),
      valueNode,
      noteNode,
    ]);
  };

  const capture = state.values.capture;
  const captureValueNode = el('strong', { class: 'dashboard-hub-state-value dashboard-control-value', text: capture.value, dataset: { controlValue: 'capture' } });
  const captureNoteNode = el('span', { class: 'dashboard-hub-state-note dashboard-control-note', text: capture.note, dataset: { controlNote: 'capture' } });
  controlValueNodes.set('capture', captureValueNode);
  controlNoteNodes.set('capture', captureNoteNode);
  controlCaptureDotNode = el('span', { class: `dashboard-hub-status-dot status-${capture.level ?? 'unknown'}`, 'aria-hidden': 'true' });

  return el('section', { class: 'card dashboard-control-card' }, [
    el('div', { class: 'dashboard-control-heading' }, [
      el('div', {}, [
        el('span', { class: 'dashboard-eyebrow', text: 'Quick capture' }),
        el('h2', { class: 'card-title', text: 'Capture hub' }),
      ]),
    ]),
    el('div', { class: 'dashboard-hub-layout' }, [
      el('div', { class: 'dashboard-hub-capture' }, [
        el('div', { class: 'dashboard-hub-state' }, [
          controlCaptureDotNode,
          el('div', { class: 'dashboard-hub-state-copy' }, [
            el('span', { class: 'dashboard-hub-kicker', text: 'Arc Capture' }),
            captureValueNode,
            captureNoteNode,
          ]),
        ]),
        el('div', { class: 'dashboard-hub-actions' }, [
          dashboardAction('Start Recording', '', 'Start a full recording', 'recording', true),
          dashboardAction('Start Instant Replay', '', 'Keep the rolling buffer running', 'replay'),
          dashboardAction('Open tuning', '#/tuning', 'GPU & fan controls', 'tuning'),
        ]),
      ]),
      el('div', { class: 'dashboard-hub-details' }, [
        detail('last', 'Last capture', 'dashboard-hub-detail-wide'),
        detail('profile', 'Active profile'),
        detail('replay', 'Instant Replay window'),
        detail('storage', 'Storage'),
      ]),
    ]),
  ]);
}

function updateDashboardControlCenter(ctx: PageContext): void {
  const state = dashboardControlCenterState(ctx);
  for (const [id, node] of controlValueNodes) node.textContent = state.values[id].value;
  for (const [id, node] of controlNoteNodes) node.textContent = state.values[id].note;
  if (controlCaptureDotNode) controlCaptureDotNode.className = `dashboard-hub-status-dot status-${state.values.capture.level ?? 'unknown'}`;
  updateDashboardCaptureActions(ctx.store.get().recordingStatus);
}

async function loadDashboardControlCenter(ctx: PageContext, force = false): Promise<void> {
  controlCenterContext = ctx;
  if (controlCenterLoadPromise && !force) return controlCenterLoadPromise;
  const generation = ++controlCenterGeneration;
  const request = Promise.all([
    api.profilesList().catch(() => null),
    api.recordingClipsList().catch(() => null),
    api.recordingSettingsGet().catch(() => null),
    api.recordingStorageInfo().catch(() => null),
  ]).then(([profiles, clips, recordingSettings, storage]) => {
    if (generation !== controlCenterGeneration) return;
    controlCenterRemote = { profiles, clips, recordingSettings, storage };
    if (controlCenterContext) updateDashboardControlCenter(controlCenterContext);
  }).finally(() => {
    if (generation === controlCenterGeneration) controlCenterLoadPromise = null;
  });
  controlCenterLoadPromise = request;
  return request;
}

export const dashboardPage: Page = {
  id: 'dashboard',

  render(container: HTMLElement, ctx: PageContext) {
    lastSig = currentSig(ctx);
    const s = ctx.store.get();
    // Dashboard is an inventory view in multi-GPU mode. Focus selection stays
    // on Tuning/Graphics; GPU cards are ordered from the complete inventory.
    const dashboardDevices = dashboardGpuOrder(s.devices);
    const device = dashboardDevices[0] ?? null;
    const firstSample = device ? dashboardSampleFor(s, device) : s.latestSample;
    const osOnly = device?.synthetic === true && device.backendKind === 'os';
    const noIntelPresentation = (s.noIntel || osOnly) && s.devices.length <= 1;
    // ReBAR is per physical inventory row, never the focused adapter's row.
    const osController: {
      name?: string | null;
      vramBytes?: number | null;
      pnpDeviceId?: string | null;
      driverVersion?: string | null;
      rebarActive?: boolean | null;
    } | null = device?.osController ?? (!device ? s.osGpu : null);
    const rebarController = osController
      ? { ...osController, rebarActive: osController.rebarActive ?? null }
      : null;
    // M17d: the no-Intel Board-partner decode - the controller's PNPDeviceID
    // SUBSYS through pure/aib.ts (works for ANY GPU); null -> the honest '-'.
    const osAib = aibOfPnpDeviceId(osController?.pnpDeviceId);
    const rebar = rebarState(rebarController);
    const osRebar = rebarState(rebarController);
    const sysRows = cpuCardRows(s.sysinfo);
    const cpuName = s.sysinfo?.cpu?.name ?? '';
    const gpuName = noIntelPresentation ? (s.osGpu?.name ?? '') : (device?.name ?? '');
    const gpuIcon = gpuIconPath(gpuIconKeyOf(gpuName, device?.gpuVendor, device ?? s.osGpu));

    clear(container);
    container.append(
      el('h1', { class: 'page-title', text: 'Dashboard' }),

      dashboardPulse(ctx),

      el('div', { class: 'card-grid' }, [
        // --- M4-D: the CPU & memory card - BEFORE the GPU card. ---
        // M4-D2 (§9): the card title is "CPU & Memory". Fed by the
        // sysinfo:get payload (CIM at boot, mock fixture in --ui-verify);
        // every field degrades honestly to '-' (pure/sysinfo.ts
        // cpuCardRows). The dashboard sig includes sysinfo, so the card
        // re-renders when the boot fetch lands after the first render.
        // M4-D2 (§6): the "Cores / clock" row's clock half is the LIVE
        // frequency (cpuFreqMhz from the telemetry tick, GHz always) - the
        // static cores/threads half comes from the sysinfo payload, the
        // live half updates IN PLACE on ticks like the GPU clocks row.
        el('section', { class: 'card sysinfo-card' }, [
          el('div', { class: 'hardware-card-heading' }, [
            el('h2', { class: 'card-title', text: 'CPU & Memory' }),
            hardwareIcon(cpuIconPath(cpuIconKeyOf(cpuName)), `${cpuName || 'CPU'} icon`, 'cpu'),
          ]),
          el('div', { class: 'card-body kv-grid' }, [
            el('div', { class: 'kv', 'data-label': 'CPU' }, [el('span', { text: sysRows.cpu })]),
            // M4-I (A3): the label is 'Cores / Clock' (the data-label
            // queries in BOTH verify variants follow).
            el('div', { class: 'kv', 'data-label': 'Cores / Clock' }, [
              el('span', { class: 'kv-cores-clock' }, [
                el('span', { text: sysRows.coresClock }),
                el('span', { class: 'kv-live-freq', text: liveFreqText(s.latestSample) }),
              ]),
            ]),
            // M4-H (C2)/M4J (B)/M4L (A): the Memory row gains the RAM TYPE
            // (DDR5 from Win32_PhysicalMemory.SMBIOSMemoryType via the pure
            // mapping) and the speed half renders in its OWN
            // .kv-static-freq span (sharing the kv-live-freq rule - never
            // that class itself, the onUpdate first-match hazard - N3).
            // M4J: the speed was ALWAYS GHz ("@ 6.0 GHz" - one decimal);
            // M4L: INVERTED back to MHz ("@ 6000 MHz", the '@ ' prefix
            // kept). M4L (F1 grid fix): BOTH spans live inside ONE
            // .kv-memory container span (the .kv-cores-clock precedent) -
            // two sibling spans inside .kv (display:contents) let
            // auto-placement drop the .kv-static-freq span into the NEXT
            // row's label column (the orphan line + the scrambled
            // Mainboard row); .kv-memory { white-space: nowrap } keeps the
            // row on one line.
            el('div', { class: 'kv', 'data-label': 'Memory' }, [
              el('span', { class: 'kv-memory' }, [
                el('span', { text: sysRows.memoryFreq ? `${sysRows.memory} ` : sysRows.memory }),
                ...(sysRows.memoryFreq ? [el('span', { class: 'kv-static-freq', text: sysRows.memoryFreq })] : []),
              ]),
            ]),
            // M4J (B): the 'Mainboard' row replaces the M4-I 'Cache' row -
            // Win32_BaseBoard Manufacturer + Product via the short-map
            // ("ASUSTeK MAXIMUS VII RANGER"); the Product alone when the
            // manufacturer is unknown; '-' when neither.
            el('div', { class: 'kv', 'data-label': 'Mainboard' }, [el('span', { text: sysRows.mainboard })]),
          ]),
        ]),

        // --- GPU cards ---
        // M152: with multiple adapters each card is a complete physical-GPU
        // readout. The focused-device selector is intentionally absent here;
        // Tuning/Graphics retain their own target selectors.
        ...(noIntelPresentation
          ? [
              el('section', { class: 'card device-card', dataset: device ? { deviceKey: dashboardDeviceKey(device) } : undefined }, [
                el('div', { class: 'device-card-head' }, [
                  el('div', { class: 'hardware-card-heading' }, [
                    el('h2', { class: 'card-title', text: 'GPU 1' }),
                    hardwareIcon(gpuIcon, `${gpuName || 'GPU'} icon`, 'gpu'),
                  ]),
                ]),
                // M4-I (D3)/M17d: the no-Intel branch renders the real OS
                // and vendor rows, with every unavailable field honest.
                el('div', { class: 'card-body kv-grid' }, [
                  el('div', { class: 'kv', 'data-label': 'GPU' }, [el('span', { text: s.osGpu?.name ?? '-' })]),
                  el('div', { class: 'kv', 'data-label': 'Board partner' }, [
                    el('span', {
                      class: osAib ? undefined : 'text-unknown',
                      text: osAib ? (osAib.model ? `${osAib.vendor} (${osAib.model})` : osAib.vendor) : '-',
                    }),
                  ]),
                  el('div', { class: 'kv', 'data-label': 'Driver version' }, [el('span', { text: osController?.driverVersion ?? '-' })]),
                  el('div', { class: 'kv', 'data-label': 'Compute' }, [el('span', {
                    class: typeof s.vendorInfo?.computeCores === 'number' && s.vendorInfo.computeCores > 0 ? undefined : 'text-unknown',
                    text: typeof s.vendorInfo?.computeCores === 'number' && Number.isFinite(s.vendorInfo.computeCores) && s.vendorInfo.computeCores > 0
                      ? `${s.vendorInfo.computeCores} Cores`
                      : '-',
                  })]),
                  el('div', { class: 'kv', 'data-label': 'Clocks' }, [el('span', { class: 'kv-clocks', text: noIntelClocksText(firstSample) })]),
                  el('div', { class: 'kv', 'data-label': 'VRAM' }, [el('span', { text: vramRowValue(s.vendorInfo?.vramBytes ?? s.osGpu?.vramBytes, null) })]),
                  ...(sharedMemoryBytesOf(null, s.osGpu) !== null
                    ? [el('div', { class: 'kv', 'data-label': 'Shared GPU Memory' }, [el('span', { text: `${formatGpuMemoryGb(sharedMemoryBytesOf(null, s.osGpu))} GB` })])]
                    : []),
                  el('div', { class: 'kv kv-rebar' }, [
                    el('span', { class: `chip rebar-pill status-${osRebar.level}`, text: osRebar.label }),
                  ]),
                ]),
                el('p', { class: 'card-note', text: 'Non supported GPU - overclocking requires an Intel Arc GPU; this state is permanent on non-Intel machines.' }),
              ]),
            ]
          : device
            ? [dashboardGpuCard(device, 1, s)]
            : [el('section', { class: 'card device-card' }, [el('div', { class: 'card-body', text: s.bootError ?? 'Searching for a graphics device…' })])]),

        ...dashboardDevices.slice(1).map((gpu, index) => dashboardGpuCard(gpu, index + 2, s)),

        // --- M3-A: the general GPU Status card (was the Service Status card) ---
        healthCard(ctx),
      ]),

        // Performance Pulse above owns live telemetry; the Capture Hub
      // keeps the bottom of the dashboard focused on actions and recent work.
      dashboardControlCenter(ctx),
    );
    void loadDashboardControlCenter(ctx);
    if (controlCenterRefreshTimer) clearInterval(controlCenterRefreshTimer);
    controlCenterRefreshTimer = setInterval(() => {
      if (controlCenterContext === ctx) void loadDashboardControlCenter(ctx, true);
    }, 15000);
  },

  onUpdate(container: HTMLElement, ctx: PageContext) {
    // Full re-render only when a status slot changed (boot probe, boot
    // errors) - NOT on telemetry ticks. A tick refreshes the live cards and
    // Capture Hub values in place; the clocks health row is gone.
    const sig = currentSig(ctx);
    if (dashboardNeedsFullRender(lastSig, sig)) {
      lastSig = sig;
      dashboardPage.render(container, ctx);
      return;
    }
    // M2C-B B8 (M4-D update): the device-card COMBINED clocks row
    // tracks the latest sample in place (the card itself only re-renders
    // on status changes). M17d: the no-Intel branch is wired the same way -
    // the vendor lane's sample (NVML clock graphics = gpuClockMhz +
    // NVML_CLOCK_MEM = memClockMhz) replaces the static '- MHz Core / -
    // MHz Memory' on ticks (the pre-M17d noIntel flag skipped the row).
    const live = ctx.store.get();
    const clockNodes = container.querySelectorAll<HTMLElement>('.device-card[data-device-key] .kv[data-label="Clocks"] span');
    clockNodes.forEach((clocksValue) => {
      const key = clocksValue.closest<HTMLElement>('.device-card')?.dataset.deviceKey;
      const liveDevice = live.devices.find((candidate) => dashboardDeviceKey(candidate) === key) ?? null;
      const sample = liveDevice ? dashboardSampleFor(live, liveDevice) : null;
      const osOnly = liveDevice?.synthetic === true && liveDevice.backendKind === 'os';
      if (live.noIntel || osOnly) {
        const core = sample?.gpuClockMhz;
        const coreText = typeof core === 'number' && Number.isFinite(core) ? core : '-';
        const memText = typeof sample?.memClockMhz === 'number' && Number.isFinite(sample.memClockMhz) ? sample.memClockMhz : '-';
        clocksValue.textContent = `${coreText} MHz Core / ${memText} MHz Memory`;
      } else {
        const core = liveDevice?.graphicsClockMHz;
        const mem = sample?.memClockMhz;
        clocksValue.textContent = `${core !== undefined ? core : '--'} MHz Core / ${mem !== undefined ? mem : '--'} MHz Memory`;
      }
    });
    // A no-device system card has no physical key. Keep its existing
    // OS/vendor clock path alive for that explicit fallback view.
    if (live.devices.length === 0) {
      const clocksValue = container.querySelector<HTMLElement>('.card-grid .kv[data-label="Clocks"] span');
      if (clocksValue) clocksValue.textContent = noIntelClocksText(live.latestSample);
    }
    // M4-D2 (§6): the CPU card's "Cores / clock" LIVE half (the current
    // frequency, GHz always) tracks the telemetry tick in place - same
    // pattern as the GPU clocks row.
    const liveFreq = container.querySelector<HTMLElement>('.sysinfo-card .kv-live-freq');
    if (liveFreq) liveFreq.textContent = liveFreqText(ctx.store.get().latestSample);
    updateDashboardPulse(ctx);
    updateDashboardControlCenter(ctx);
  },

  leave() {
    if (controlCenterRefreshTimer) clearInterval(controlCenterRefreshTimer);
    controlCenterRefreshTimer = null;
    controlCenterContext = null;
    controlCenterGeneration += 1;
    controlCenterLoadPromise = null;
    controlCenterValueNodesReset();
  },
};

function controlCenterValueNodesReset(): void {
  controlValueNodes.clear();
  controlNoteNodes.clear();
  controlCaptureActionNodes.clear();
  controlCaptureDotNode = null;
}
