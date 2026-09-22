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
import { buildDeviceSelect } from '../components/device-select.ts';
import { decodeDriverVersion, shaderUnits } from '../pure/driver.ts';
import { cpuCardRows, rebarState, vramRowValue } from '../pure/sysinfo.ts';
import { formatGpuMemoryGb } from '../pure/gpu-memory.ts';
import { cpuIconKeyOf, cpuIconPath, gpuIconKeyOf, gpuIconPath } from '../pure/hardware-icons.ts';
import { deviceHardwareKey } from '../pure/device.ts';
import { dashboardDeviceStatusLabel, dashboardGpuOrder } from '../pure/dashboard.ts';
import { dashboardRetailAssetPath } from '../pure/dashboard-retail-assets.ts';
import { createIntelDriverCheckLoader, intelDriverKind, newerIntelRelease, type IntelDriverKind, type IntelDriverUpdateCheck } from '../pure/intel-driver-updates.ts';
import { showIntelDriverUpdateDialog } from '../components/intel-driver-update-dialog.ts';
import { aibOf, aibOfPnpDeviceId } from '../pure/aib.ts';
import { api } from '../ipc.ts';
import { toast } from '../components/toast.ts';
import type { ProfilesEnvelope, RecordingClip, RecordingSettings, RecordingStorageInfo, TelemetrySample } from '../types.ts';
import { TELEMETRY_HISTORY_POINTS, TELEMETRY_PULSE_COLORS } from '../pure/telemetry-visuals.ts';

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
  { id: 'vram', label: 'VRAM in use', unit: 'GiB', color: TELEMETRY_PULSE_COLORS.memory },
];

const DASHBOARD_GAUGE_RADIUS = 42;
const DASHBOARD_HISTORY_LIMIT = TELEMETRY_HISTORY_POINTS;
const intelDriverNoticeNodes = new Map<string, { row: HTMLElement; content: HTMLElement; kind: IntelDriverKind; installed: string }>();
const loadIntelDriverCheck = createIntelDriverCheckLoader(() => api.intelDriverUpdateCheck());

function renderIntelDriverNotice(key: string, check: IntelDriverUpdateCheck): void {
  const entry = intelDriverNoticeNodes.get(key);
  if (!entry || !entry.row.isConnected) return;
  const release = newerIntelRelease(entry.kind, entry.installed, check);
  if (!release) return;
  entry.content.replaceChildren(
    el('span', { text: `${entry.installed} → ${release.version}` }),
    el('button', {
      class: 'btn intel-driver-update-button', type: 'button', text: 'New Driver Version Available',
      'aria-label': `New Intel driver version ${release.version} available; installed version ${entry.installed}`,
      onClick: () => showIntelDriverUpdateDialog(entry.kind, entry.installed, release),
    }),
  );
  entry.row.hidden = false;
}
function dashboardUtilizationPercent(value: number | undefined): number | null {
  return value === undefined || !Number.isFinite(value)
    ? null
    : Math.max(0, Math.min(100, Math.round(value)));
}

function dashboardUtilizationArcPath(percent: number): string {
  const startX = 52;
  const startY = 52 - DASHBOARD_GAUGE_RADIUS;
  if (percent <= 0) return `M ${startX} ${startY}`;
  if (percent >= 100) {
    const bottomY = 52 + DASHBOARD_GAUGE_RADIUS;
    return `M ${startX} ${startY} A ${DASHBOARD_GAUGE_RADIUS} ${DASHBOARD_GAUGE_RADIUS} 0 0 1 ${startX} ${bottomY} A ${DASHBOARD_GAUGE_RADIUS} ${DASHBOARD_GAUGE_RADIUS} 0 0 1 ${startX} ${startY}`;
  }
  const angle = (percent / 100) * Math.PI * 2;
  const endX = 52 + DASHBOARD_GAUGE_RADIUS * Math.sin(angle);
  const endY = 52 - DASHBOARD_GAUGE_RADIUS * Math.cos(angle);
  const largeArc = percent > 50 ? 1 : 0;
  return `M ${startX} ${startY} A ${DASHBOARD_GAUGE_RADIUS} ${DASHBOARD_GAUGE_RADIUS} 0 ${largeArc} 1 ${endX.toFixed(3)} ${endY.toFixed(3)}`;
}

type DashboardPulseLane = {
  key: string;
  vramCapacityGiB: number | null;
  history: TelemetrySample[];
  startedAt: number;
  valueNodes: Map<DashboardPulseId, HTMLElement>;
  pathNodes: Map<DashboardPulseId, SVGPathElement>;
  areaPathNodes: Map<DashboardPulseId, SVGPathElement>;
  hoverNodes: Map<DashboardPulseId, { surface: HTMLElement; crosshair: HTMLElement; tooltip: HTMLElement }>;
  rangeMinNodes: Map<DashboardPulseId, HTMLElement>;
  rangeMaxNodes: Map<DashboardPulseId, HTMLElement>;
  gaugeValueNode: HTMLElement | null;
  gaugeRingNode: SVGPathElement | null;
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
const CAPTURE_ENGINE_IDLE_MESSAGE = 'Capture engine idle until recording is requested';

function recordingActionAvailable(status: AppState['recordingStatus']): boolean {
  return status?.available === true
    || (status?.probeComplete !== true && status?.error === CAPTURE_ENGINE_IDLE_MESSAGE);
}
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

function dashboardVramCapacityBytes(
  device: {
    integrated?: boolean | null;
    mobile?: boolean | null;
    vramBytes?: number | null;
    sharedMemoryBytes?: number | null;
  } | null | undefined,
  sharedMemoryFallbackBytes: number | null = null,
): number | null {
  if (!device) return null;
  if (typeof device.vramBytes === 'number' && Number.isFinite(device.vramBytes) && device.vramBytes > 0) {
    return device.vramBytes;
  }
  const sharedCapacity = typeof device.sharedMemoryBytes === 'number'
    && Number.isFinite(device.sharedMemoryBytes)
    && device.sharedMemoryBytes > 0
    ? device.sharedMemoryBytes
    : null;
  const fallbackCapacity = typeof sharedMemoryFallbackBytes === 'number'
    && Number.isFinite(sharedMemoryFallbackBytes)
    && sharedMemoryFallbackBytes > 0
    ? sharedMemoryFallbackBytes
    : null;
  if (sharedCapacity !== null && (device.integrated === true || device.mobile === true || fallbackCapacity !== null)) {
    return sharedCapacity;
  }
  return fallbackCapacity;
}

function pulseLaneFor(key: string): DashboardPulseLane {
  const existing = dashboardPulseLanes.get(key);
  if (existing) return existing;
  const created: DashboardPulseLane = {
    key,
    vramCapacityGiB: null,
    history: [],
    startedAt: Date.now(),
    valueNodes: new Map(),
    pathNodes: new Map(),
    areaPathNodes: new Map(),
    hoverNodes: new Map(),
    rangeMinNodes: new Map(),
    rangeMaxNodes: new Map(),
    gaugeValueNode: null,
    gaugeRingNode: null,
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
  lane.history = [...lane.history, sample].slice(-DASHBOARD_HISTORY_LIMIT);
}

function pulseSampleValue(id: DashboardPulseId, sample: TelemetrySample): number | undefined {
  if (id === 'gpu-util') return sample.utilPct ?? sample.gpuUtilPct ?? undefined;
  if (id === 'temperature') return sample.tempC;
  if (id === 'power') return sample.powerW;
  return typeof sample.gpuMemUsedBytes === 'number' && Number.isFinite(sample.gpuMemUsedBytes)
    ? sample.gpuMemUsedBytes / (1024 ** 3)
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

function pulseRangeValue(id: DashboardPulseId, value: number): string {
  if (id === 'vram') return Number.isInteger(value) ? String(value) : value.toFixed(1);
  return String(Math.round(value));
}

function pulseHoverValue(id: DashboardPulseId, value: number): string {
  return id === 'power' || id === 'vram' ? value.toFixed(1) : String(Math.round(value));
}

function pulseGraphPoints(lane: DashboardPulseLane, id: DashboardPulseId): Array<{ t: number; value: number }> {
  return lane.history
    .map((sample) => ({ t: sample.t, value: pulseSampleValue(id, sample) }))
    .filter((point): point is { t: number; value: number } => typeof point.value === 'number' && Number.isFinite(point.value));
}

function pulseGraphRange(lane: DashboardPulseLane, id: DashboardPulseId): { min: number; max: number } {
  return {
    min: 0,
    max: id === 'gpu-util' || id === 'temperature'
      ? 100
      : id === 'power'
        ? 400
        : lane.vramCapacityGiB ?? 1,
  };
}

function updatePulsePath(lane: DashboardPulseLane, id: DashboardPulseId): void {
  const path = lane.pathNodes.get(id);
  const area = lane.areaPathNodes.get(id);
  if (!path) return;
  const values = pulseHistoryValues(lane, id);
  const graphRange = pulseGraphRange(lane, id);
  const minNode = lane.rangeMinNodes.get(id);
  const maxNode = lane.rangeMaxNodes.get(id);
  if (minNode) minNode.textContent = pulseRangeValue(id, graphRange.min);
  if (maxNode) maxNode.textContent = pulseRangeValue(id, graphRange.max);
  if (values.length < 2) {
    const y = values.length === 1 && graphRange
      ? 34 - ((values[0] - graphRange.min) / Math.max(0.001, graphRange.max - graphRange.min)) * 30
      : 34;
    path.setAttribute('d', `M 0 ${y} L 120 ${y}`);
    if (area) area.setAttribute('d', values.length === 1 ? `M 0 34 L 0 ${y} L 120 ${y} L 120 34 Z` : 'M 0 34 L 120 34 Z');
    return;
  }
  const min = graphRange?.min ?? 0;
  const max = graphRange?.max ?? 1;
  const span = Math.max(0.001, max - min);
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 120;
    const y = Math.max(4, Math.min(34, 34 - ((value - min) / span) * 30));
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  const line = `M ${points.join(' L ')}`;
  path.setAttribute('d', line);
  if (area) area.setAttribute('d', `${line} L 120 34 L 0 34 Z`);
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
  const utilization = dashboardUtilizationPercent(sample ? pulseSampleValue('gpu-util', sample) : undefined);
  if (lane.gaugeValueNode) lane.gaugeValueNode.textContent = utilization === null ? '-' : `${utilization}%`;
  if (lane.gaugeRingNode) {
    lane.gaugeRingNode.setAttribute('d', dashboardUtilizationArcPath(utilization ?? 0));
  }
  for (const metric of DASHBOARD_PULSE) {
    const valueNode = lane.valueNodes.get(metric.id);
    if (valueNode) valueNode.textContent = pulseDisplayValue(metric.id, sample);
    updatePulsePath(lane, metric.id);
  }
  updateSessionStats(lane);
}

function dashboardActiveDevice(state: AppState): AppState['devices'][number] | null {
  const ordered = dashboardGpuOrder(state.devices);
  return ordered.find((device) => device.id === state.deviceId) ?? ordered[0] ?? null;
}

type DashboardRetailArtVariant = 'discrete' | 'integrated';

function dashboardRetailArt(variant: DashboardRetailArtVariant, label: string): SVGSVGElement {
  const svg = svgEl('svg', {
    class: `dashboard-retail-art dashboard-retail-art-${variant}`,
    viewBox: '0 0 180 72',
    role: 'img',
    'aria-label': label,
  });
  if (variant === 'discrete') {
    svg.append(
      svgEl('path', { class: 'dashboard-retail-art-board', d: 'M19 17h119l20 13v25H19c-5 0-9-4-9-9V26c0-5 4-9 9-9Z' }),
      svgEl('path', { class: 'dashboard-retail-art-bracket', d: 'M10 26h10v29H10M159 30h10v25h-10' }),
      svgEl('circle', { class: 'dashboard-retail-art-fan', cx: 65, cy: 38, r: 15 }),
      svgEl('circle', { class: 'dashboard-retail-art-fan', cx: 111, cy: 38, r: 15 }),
      svgEl('circle', { class: 'dashboard-retail-art-fan-core', cx: 65, cy: 38, r: 4 }),
      svgEl('circle', { class: 'dashboard-retail-art-fan-core', cx: 111, cy: 38, r: 4 }),
      svgEl('path', { class: 'dashboard-retail-art-trace', d: 'M27 25h20M27 51h23M128 24h9M128 51h13' }),
      svgEl('path', { class: 'dashboard-retail-art-edge', d: 'M35 58h88l5 6H30Z' }),
    );
  } else {
    svg.append(
      svgEl('rect', { class: 'dashboard-retail-art-package', x: 48, y: 9, width: 84, height: 54, rx: 6 }),
      svgEl('rect', { class: 'dashboard-retail-art-die', x: 67, y: 20, width: 46, height: 32, rx: 3 }),
      svgEl('path', { class: 'dashboard-retail-art-pins', d: 'M40 18h8M40 28h8M40 38h8M40 48h8M132 18h8M132 28h8M132 38h8M132 48h8M61 1v8M73 1v8M85 1v8M97 1v8M109 1v8M61 63v8M73 63v8M85 63v8M97 63v8M109 63v8' }),
      svgEl('path', { class: 'dashboard-retail-art-trace', d: 'M74 28h32M74 36h32M74 44h22' }),
    );
  }
  return svg;
}

function pulseLaneElement(
  lane: DashboardPulseLane,
  gpuLabel: string,
  gpuName: string,
  gpuIcon: string | null,
  gpuRetailAsset: string | null,
  retailVariant: DashboardRetailArtVariant,
  sample: TelemetrySample | null,
  vramCapacityGiB: number | null,
): HTMLElement {
  lane.vramCapacityGiB = vramCapacityGiB;
  lane.valueNodes.clear();
  lane.pathNodes.clear();
  lane.areaPathNodes.clear();
  lane.hoverNodes.clear();
  lane.rangeMinNodes.clear();
  lane.rangeMaxNodes.clear();
  lane.gaugeValueNode = null;
  lane.gaugeRingNode = null;
  const pulseCards = DASHBOARD_PULSE.map((metric) => {
    const area = svgEl('path', {
      class: 'dashboard-sparkline-area',
      d: 'M 0 34 L 120 34 Z',
      fill: metric.color,
      'fill-opacity': metric.id === 'gpu-util' ? .16 : 0,
    });
    const baseline = svgEl('path', {
      class: 'dashboard-sparkline-baseline',
      d: 'M 0 34 L 120 34',
      fill: 'none',
      'stroke-width': 1,
    });
    const path = svgEl('path', {
      d: 'M 0 20 L 120 20',
      fill: 'none',
      stroke: metric.color,
      'stroke-width': metric.id === 'gpu-util' ? 3.2 : 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'vector-effect': 'non-scaling-stroke',
    }) as SVGPathElement;
    const svg = svgEl('svg', {
      class: 'dashboard-sparkline',
      viewBox: '0 0 120 40',
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': `${gpuLabel} ${metric.label} history`,
    });
    svg.append(baseline, area, path);
    const grid = el('div', { class: 'dashboard-sparkline-grid', 'aria-hidden': 'true' }, [
      el('span', { class: 'dashboard-sparkline-grid-line dashboard-sparkline-grid-top' }),
      el('span', { class: 'dashboard-sparkline-grid-line dashboard-sparkline-grid-mid' }),
      el('span', { class: 'dashboard-sparkline-grid-line dashboard-sparkline-grid-bottom' }),
      el('span', { class: 'dashboard-sparkline-grid-line dashboard-sparkline-grid-quarter' }),
      el('span', { class: 'dashboard-sparkline-grid-line dashboard-sparkline-grid-half' }),
      el('span', { class: 'dashboard-sparkline-grid-line dashboard-sparkline-grid-three-quarter' }),
    ]);
    const crosshair = el('span', { class: 'dashboard-sparkline-crosshair', hidden: true, 'aria-hidden': 'true' });
    const tooltip = el('span', { class: 'dashboard-sparkline-tooltip', hidden: true, role: 'status' });
    const surface = el('div', { class: 'dashboard-sparkline-surface', 'aria-label': `${gpuLabel} ${metric.label} plot` }, [
      grid,
      svg,
      crosshair,
      tooltip,
    ]);
    surface.addEventListener('pointermove', (event) => {
      const points = pulseGraphPoints(lane, metric.id);
      const rect = surface.getBoundingClientRect();
      if (points.length === 0 || rect.width <= 0) return;
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const index = points.length <= 1 ? 0 : Math.round(ratio * (points.length - 1));
      const point = points[index];
      if (!point) return;
      crosshair.style.left = `${ratio * 100}%`;
      crosshair.hidden = false;
      tooltip.textContent = `${pulseHoverValue(metric.id, point.value)} ${metric.unit}`;
      tooltip.style.left = `${ratio * 100}%`;
      tooltip.style.transform = ratio > .55 ? 'translateX(-100%)' : 'none';
      tooltip.hidden = false;
    });
    surface.addEventListener('pointerleave', () => {
      crosshair.hidden = true;
      tooltip.hidden = true;
    });
    const valueNode = el('strong', { class: 'dashboard-pulse-value', text: pulseDisplayValue(metric.id, sample) });
    lane.valueNodes.set(metric.id, valueNode);
    lane.pathNodes.set(metric.id, path);
    lane.areaPathNodes.set(metric.id, area);
    lane.hoverNodes.set(metric.id, { surface, crosshair, tooltip });
    const rangeMinNode = el('strong', { text: '—' });
    const rangeMaxNode = el('strong', { text: '—' });
    lane.rangeMinNodes.set(metric.id, rangeMinNode);
    lane.rangeMaxNodes.set(metric.id, rangeMaxNode);
    const range = el('div', { class: 'dashboard-sparkline-range', 'aria-label': `${metric.label} graph range` }, [
      el('span', {}, [el('span', { class: 'dashboard-sparkline-range-label', text: 'Min' }), rangeMinNode]),
      el('span', {}, [el('span', { class: 'dashboard-sparkline-range-label', text: 'Max' }), rangeMaxNode]),
    ]);
    return el('div', { class: 'dashboard-pulse-metric', dataset: { pulseMetric: metric.id } }, [
      el('div', { class: 'dashboard-pulse-metric-head' }, [
        el('span', { class: 'dashboard-pulse-label', text: metric.label }),
        el('span', { class: 'dashboard-pulse-inline-value' }, [valueNode, el('span', { class: 'dashboard-pulse-unit', text: metric.unit })]),
      ]),
      surface,
      range,
    ]);
  });
  lane.runtimeNode = el('strong', { text: formatSessionAge(lane.startedAt) });
  lane.peakNode = el('strong', { text: '-' });
  lane.averageNode = el('strong', { text: '-' });
  lane.gaugeValueNode = el('strong', { class: 'dashboard-pulse-gauge-value', text: '-' });
  lane.gaugeRingNode = svgEl('path', {
    class: 'dashboard-pulse-gauge-ring',
    d: 'M 52 10',
    fill: 'none',
    'stroke-width': 7,
    'stroke-linecap': 'butt',
    'aria-hidden': 'true',
  });
  const gaugeSvg = svgEl('svg', { class: 'dashboard-pulse-gauge-svg', viewBox: '0 0 104 104', 'aria-hidden': 'true' });
  gaugeSvg.append(
    svgEl('circle', { class: 'dashboard-pulse-gauge-track', cx: 52, cy: 52, r: DASHBOARD_GAUGE_RADIUS, fill: 'none', 'stroke-width': 7 }),
    lane.gaugeRingNode,
  );
  const gauge = el('div', { class: 'dashboard-pulse-gauge', role: 'img', 'aria-label': `${gpuLabel} GPU utilization` }, [
    gaugeSvg,
    el('div', { class: 'dashboard-pulse-gauge-center' }, [
      lane.gaugeValueNode,
      el('span', { class: 'dashboard-pulse-gauge-label', text: 'GPU load' }),
    ]),
  ]);
  const artwork = hardwareIcon(gpuIcon, `${gpuName || 'GPU'} icon`, 'gpu');
  const identity = el('div', { class: 'dashboard-pulse-identity' }, [
    ...(artwork ? [artwork] : []),
    el('div', { class: 'dashboard-pulse-identity-copy' }, [
      el('span', { class: 'dashboard-eyebrow', text: gpuLabel }),
      el('h3', { class: 'card-title', text: gpuName || 'GPU' }),
      el('span', { class: 'dashboard-pulse-identity-note', text: 'Active device' }),
    ]),
  ]);
  const liveStatus = el('div', { class: 'dashboard-pulse-live-status' }, [
    el('span', { class: 'dashboard-pulse-live-dot', 'aria-hidden': 'true' }),
    el('span', { text: 'ONLINE' }),
  ]);
  const retailArt = gpuRetailAsset ? null : dashboardRetailArt(retailVariant, `${gpuLabel} ${retailVariant} GPU artwork`);
  const retailAsset = gpuRetailAsset
    ? el('img', {
        class: 'dashboard-retail-art-asset',
        src: gpuRetailAsset,
        alt: `${gpuLabel} GPU retail artwork`,
        loading: 'eager',
        decoding: 'async',
      })
    : null;
  const retailArtSlot = el('div', { class: 'dashboard-retail-art-slot' }, [retailAsset, retailArt]);
  const visualColumn = el('div', { class: 'dashboard-pulse-visual' }, [gauge, retailArtSlot, identity, liveStatus]);
  const sessionStats = el('div', { class: 'dashboard-session-stats' }, [
    el('span', { class: 'dashboard-session-title', text: 'Since launch' }),
    el('span', { class: 'dashboard-session-stat' }, [el('span', { text: 'Session' }), lane.runtimeNode]),
    el('span', { class: 'dashboard-session-stat' }, [el('span', { text: 'Peak temp' }), lane.peakNode]),
    el('span', { class: 'dashboard-session-stat' }, [el('span', { text: 'Average GPU' }), lane.averageNode]),
  ]);
  updatePulseLane(lane, sample);
  return el('section', { class: 'dashboard-pulse-lane', dataset: { deviceKey: lane.key } }, [
    el('div', { class: 'dashboard-pulse-hud' }, [
      visualColumn,
      el('div', { class: 'dashboard-pulse-grid' }, pulseCards),
    ]),
    sessionStats,
  ]);
}

function dashboardPulse(ctx: PageContext): HTMLElement {
  const state = ctx.store.get();
  const devices = dashboardGpuOrder(state.devices);
  const activeDevice = dashboardActiveDevice(state);
  const activeIndex = activeDevice ? devices.findIndex((device) => device.id === activeDevice.id) : -1;
  const entries = activeDevice
    ? [{
        device: activeDevice,
        label: `GPU ${activeIndex >= 0 ? activeIndex + 1 : 1}`,
        name: activeDevice.name,
        key: dashboardDeviceKey(activeDevice),
        sample: dashboardSampleFor(state, activeDevice),
        vramCapacityBytes: dashboardVramCapacityBytes(
          activeDevice,
          activeDevice.integrated === true || activeDevice.mobile === true ? state.sysinfo?.ram.totalBytes ?? null : null,
        ),
      }]
    : [{
        device: null,
        label: 'System',
        name: state.osGpu?.name ?? 'No GPU selected',
        key: 'system',
        sample: state.latestSample,
        vramCapacityBytes: dashboardVramCapacityBytes(
          state.osGpu,
          state.osGpu?.vramBytes == null ? state.osGpu?.sharedMemoryBytes ?? state.sysinfo?.ram.totalBytes ?? null : null,
        ),
      }];
  const activeKeys = new Set(entries.map((entry) => entry.key));
  for (const key of dashboardPulseLanes.keys()) {
    if (!activeKeys.has(key)) dashboardPulseLanes.delete(key);
  }
  return el('section', { class: 'card dashboard-pulse-card', dataset: { gpuCount: String(devices.length) } }, [
    el('div', { class: 'dashboard-pulse-heading' }, [
      el('div', { class: 'dashboard-pulse-heading-copy' }, [
        el('span', { class: 'dashboard-eyebrow', text: 'GPU Telemetry' }),
        el('h2', { class: 'card-title', text: 'Live Monitoring' }),
      ]),
      el('span', { class: `dashboard-pulse-device${entries.length ? '' : ' text-unknown' }`, text: `${entries.length} GPU${entries.length === 1 ? '' : 's'}` }),
    ]),
    el('div', { class: 'dashboard-pulse-lanes' }, entries.map((entry) => pulseLaneElement(
      pulseLaneFor(entry.key), entry.label, entry.name,
      entry.device ? gpuIconPath(gpuIconKeyOf(entry.device.name, entry.device.gpuVendor, entry.device)) : null,
      entry.device ? (() => {
        const aib = aibOf(entry.device.pciSubsysVendorId, entry.device.pciSubsysId);
        return dashboardRetailAssetPath({
          name: entry.device.name,
          gpuVendor: entry.device.gpuVendor,
          integrated: entry.device.integrated,
          mobile: entry.device.mobile,
          aibVendor: aib?.vendor,
          aibVendorId: entry.device.pciSubsysVendorId,
          aibModel: aib?.model,
        });
      })() : null,
      entry.device && (entry.device.integrated === true || /\b(?:uhd|iris|vega|integrated|igpu)\b/i.test(entry.device.name)) ? 'integrated' : 'discrete',
      entry.sample,
      entry.vramCapacityBytes === null ? null : entry.vramCapacityBytes / (1024 ** 3),
    ))),
  ]);
}

function updateDashboardPulse(ctx: PageContext): void {
  const state = ctx.store.get();
  const activeDevice = dashboardActiveDevice(state);
  updatePulseLane(
    pulseLaneFor(activeDevice ? dashboardDeviceKey(activeDevice) : 'system'),
    activeDevice ? dashboardSampleFor(state, activeDevice) : state.latestSample,
  );
}

function dashboardGpuCard(device: AppState['devices'][number], index: number, state: AppState, visible = true): HTMLElement {
  const sample = dashboardSampleFor(state, device);
  const rebar = rebarState(device.osController ? { rebarActive: device.osController.rebarActive } : null);
  const aib = aibOf(device.pciSubsysVendorId, device.pciSubsysId);
  const core = Number.isFinite(device.graphicsClockMHz) ? device.graphicsClockMHz : null;
  const memory = typeof sample?.memClockMhz === 'number' && Number.isFinite(sample.memClockMhz)
    ? sample.memClockMhz
    : null;
  const intelKind = intelDriverKind(device.gpuVendor, device.name);
  const installedDriver = decodeDriverVersion(device.osController?.driverVersion ?? device.driverVersion);
  const driverRow = intelKind
    ? el('div', { class: 'kv intel-driver-version-row', 'data-label': 'Driver version' }, [
        el('span', { class: 'intel-driver-update-content', 'aria-live': 'polite', text: installedDriver ?? '-' }),
      ])
    : null;
  if (driverRow && intelKind && installedDriver) {
    const key = dashboardDeviceKey(device);
    const entry = {
      row: driverRow,
      content: driverRow.querySelector('.intel-driver-update-content') as HTMLElement,
      kind: intelKind,
      installed: installedDriver,
    };
    intelDriverNoticeNodes.set(key, entry);
    void loadIntelDriverCheck().then((check) => {
      if (check && intelDriverNoticeNodes.get(key) === entry) renderIntelDriverNotice(key, check);
    });
  }
  return el('section', { class: 'card device-card', hidden: !visible, dataset: { deviceKey: dashboardDeviceKey(device) } }, [
    el('div', { class: 'device-card-head' }, [
      el('div', { class: 'hardware-card-heading' }, [
        el('h2', { class: 'card-title', text: `GPU ${index}` }),
        hardwareIcon(gpuIconPath(gpuIconKeyOf(device.name, device.gpuVendor, device)), `${device.name} icon`, 'gpu'),
      ]),
    ]),
    el('div', { class: 'card-body kv-grid' }, [
      el('div', { class: 'kv', 'data-label': 'GPU' }, [el('span', { text: device.name })]),
      ...(driverRow ? [driverRow] : []),
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

type DashboardActionKind = 'recording' | 'replay' | 'tuning' | 'profile' | 'graphics';

const DASHBOARD_ACTION_PATHS: Record<DashboardActionKind, string> = {
  recording: 'M8 5v14l11-7L8 5Z',
  replay: 'M20 11a8 8 0 0 0-14-4L4 9M4 5v4h4M4 13a8 8 0 0 0 14 4l2-2M20 19v-4h-4',
  tuning: 'M4 7h16M4 12h16M4 17h16',
  profile: 'M5 5h14v14H5zM8 9h8M8 13h5',
  graphics: 'M4 17 9 12l3 3 5-7 3 3',
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
    disabled: dashboardCaptureActionBusy || !recordingActionAvailable(controlCenterContext?.store.get().recordingStatus ?? null),
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
    nodes.button.disabled = dashboardCaptureActionBusy || !recordingActionAvailable(status);
    nodes.button.title = copy.label;
    nodes.button.setAttribute('aria-label', copy.label);
  }
}

async function toggleDashboardCapture(mode: DashboardCaptureActionKind): Promise<void> {
  const ctx = controlCenterContext;
  if (!ctx || dashboardCaptureActionBusy) return;
  const status = ctx.store.get().recordingStatus;
  if (!recordingActionAvailable(status)) {
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
  const activeDevice = dashboardActiveDevice(s);
  const activeKey = activeDevice ? dashboardDeviceKey(activeDevice) : null;
  const detectionRows = devices.length > 1
    ? devices.map((gpu, index) => gpuDetectionPill(gpu, index, devices.length, dashboardDeviceKey(gpu) === activeKey))
    : rows.map((row) => healthRowEl(row, ctx));

  return el('section', { class: 'card health-card' }, [
    el('h2', { class: 'card-title', text: 'GPU Status' }),
    el('div', { class: 'card-body' }, [
      ...detectionRows,
      ...(devices.length > 1 ? rows.filter((row) => row.id !== 'device').map((row) => healthRowEl(row, ctx)) : []),
    ]),
  ]);
}

function gpuDetectionPill(device: AppState['devices'][number], index: number, gpuCount: number, visible = true): HTMLElement {
  return el('div', { class: 'health-row health-gpu-detection-pill', hidden: !visible, 'data-row': `device-${index + 1}` }, [
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
  if (status.probeComplete !== true && status.error === CAPTURE_ENGINE_IDLE_MESSAGE) {
    return { value: 'Not loaded', note: 'Open Recording or start a capture' };
  }
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
      ]),
      el('div', { class: 'dashboard-hub-details' }, [
        detail('last', 'Last capture', 'dashboard-hub-detail-wide'),
        detail('profile', 'Active profile'),
        detail('replay', 'Instant Replay window'),
        detail('storage', 'Storage'),
      ]),
    ]),
    el('div', { class: 'dashboard-action-dock' }, [
      el('span', { class: 'dashboard-action-dock-label', text: 'Quick actions' }),
      el('div', { class: 'dashboard-hub-actions' }, [
        dashboardAction('Start Recording', '', 'Start a full recording', 'recording', true),
        dashboardAction('Start Instant Replay', '', 'Keep the rolling buffer running', 'replay'),
        dashboardAction('Open tuning', '#/tuning', 'GPU & fan controls', 'tuning'),
        dashboardAction('Profiles', '#/profiles', 'Save and apply presets', 'profile'),
        dashboardAction('Graphics', '#/graphics', 'Display and 3D options', 'graphics'),
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
    const activeDashboardDevice = dashboardActiveDevice(s);
    const activeDashboardKey = activeDashboardDevice ? dashboardDeviceKey(activeDashboardDevice) : null;
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
    const deviceSelect = buildDeviceSelect(ctx.store, (id) => void ctx.selectDevice?.(id));

    clear(container);
    intelDriverNoticeNodes.clear();
    container.append(
      el('header', { class: 'dashboard-hud-header' }, [
        el('div', { class: 'dashboard-hud-header-copy' }, [
          el('h1', { class: 'dashboard-hud-title', text: 'Arc Power Dashboard' }),
        ]),
        el('div', { class: 'dashboard-hud-header-controls' }, [
          ...(deviceSelect ? [
            el('div', { class: 'dashboard-hud-selector' }, [
              el('span', { class: 'dashboard-hud-selector-label', text: 'ACTIVE GPU' }),
              deviceSelect,
            ]),
          ] : []),
          el('div', { class: 'dashboard-hud-header-status' }, [
            el('span', { class: 'dashboard-pulse-live-dot', 'aria-hidden': 'true' }),
            el('span', { text: 'SYSTEM ONLINE' }),
          ]),
        ]),
      ]),

      dashboardPulse(ctx),

      // Inventory and health cards sit directly below the live-monitoring
      // hero; the capture hub follows as the secondary action surface.
      el('div', { class: 'card-grid dashboard-supporting-grid' }, [
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
            ? [dashboardGpuCard(device, 1, s, activeDashboardKey === null || dashboardDeviceKey(device) === activeDashboardKey)]
            : [el('section', { class: 'card device-card' }, [el('div', { class: 'card-body', text: s.bootError ?? 'Searching for a graphics device…' })])]),

        ...dashboardDevices.slice(1).map((gpu, index) => dashboardGpuCard(gpu, index + 2, s, activeDashboardKey === null || dashboardDeviceKey(gpu) === activeDashboardKey)),

        // --- M3-A: the general GPU Status card (was the Service Status card) ---
        healthCard(ctx),
      ]),

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
