// Arc Power - Monitoring page (M2b-B/M168): a compact Metrics surface fed by
// the telemetry IPC push. FPS, CPU, system memory, and every physical GPU get
// their own independently collapsible readout panel; GPU history remains in
// one rolling Canvas trend per signal and per adapter with a 60 s window.
// Trend cards start collapsed so the page stays dense on entry.
// FPS comes from the fps-poll IPC channel (the ETW/PresentMon lane first -
// the foreground program's per-frame present stream; the DXGI
// frame-statistics / output-duplication adapter as the fallback); when no
// present data is being captured the page shows "FPS unavailable"
// gracefully - never an error.
//
// M168: the former two-group readout is replaced by the Metrics panel grid;
// each panel owns its own dropdown and all fields stay bound to the matching
// physical adapter. The M4-D2
// "Log to file" card is DELETED from this page (item G - the Settings page
// keeps the persisted toggle; the boot-level log writer is untouched).
//
// The graph math lives in pure/graph.ts (series push, time-window trim,
// min/max scaling, downsampling - unit-tested); this file only owns the DOM
// and the thin Canvas drawing.

import { el, clear } from '../dom.ts';
import type { AppState, Page, PageContext } from '../router.ts';
import { consumeOverlayViewRequest } from '../router.ts';
import { api } from '../ipc.ts';
import type { DeviceInfo, FpsSample, TelemetrySample } from '../types.ts';
import { getMonitorLogToFile, setLatestFps, setMonitorLogToFile } from '../log-state.ts';
import { ghzFreq } from '../pure/sysinfo.ts';
import { formatGpuMemoryGb, gpuMemoryLabel } from '../pure/gpu-memory.ts';
import { chipLabelGpu } from '../pure/chip-label.ts';
import { deviceHardwareKey, stripVramSuffix } from '../pure/device.ts';
import { renderOverlaySettings } from './overlay-settings.ts';
import {
  pushSeries,
  trimSeriesWindow,
  sortSeriesByTime,
  autoScale,
  downsample,
  nearestSampleIndex,
  GRAPH_WINDOW_S,
} from '../pure/graph.ts';
import type { SeriesPoint } from '../pure/graph.ts';

const FPS_POLL_MS = 1000;
const DRAW_MAX_POINTS = 240;
// M4-D2 (plan-review M5): the PresentMon mention is gone - the FPS source is
// the DXGI frame-statistics/duplication adapter; unavailable -> honest '-'.
// M17c: the preferred source is the ETW/PresentMon lane (the foreground
// program's per-frame present stream); the DXGI desktop-presentation tier
// is the fallback. The unavailable note covers BOTH sources being silent
// (the 'FPS unavailable' ui-verify prefix is pinned).
const FPS_UNAVAILABLE_NOTE = 'FPS unavailable - no present data is being captured for the foreground program.';
const FPS_CHECKING_NOTE = 'Checking FPS…';

interface SegmentDef {
  id: string;
  label: string;
  unit: string;
  value: (s: TelemetrySample | null) => number | undefined;
}

const SEGMENTS: SegmentDef[] = [
  { id: 'clock', label: 'Core clock', unit: 'MHz', value: (s) => s?.gpuClockMhz },
  { id: 'temp', label: 'Temperature', unit: '°C', value: (s) => s?.tempC },
  { id: 'power', label: 'Power', unit: 'W', value: (s) => s?.powerW },
  // M4-I (D4): the util segment reads `gpuUtilPct ?? utilPct` - the no-Intel
  // OS GPUEngine counter is the only source there; the IGCL activity counter
  // wins on Intel when the OS counter is unpopulated.
  { id: 'util', label: 'Utilization', unit: '%', value: (s) => s?.gpuUtilPct ?? s?.utilPct },
  { id: 'fan', label: 'Fan', unit: 'RPM', value: (s) => s?.fanRpm?.[0] },
];

interface MonState {
  deviceId: number | null;
  series: Record<string, SeriesPoint[]>;
  canvases: Map<string, HTMLCanvasElement>;
  metricCanvases: Map<string, HTMLCanvasElement>;
  fpsTileValue: HTMLElement | null;
  fpsNote: HTMLElement | null;
  metricBindings: MetricBinding[];
  fpsBindings: FpsBinding[];
  // M4-C (round-1 fix): the last hover's crosshair position (canvas CSS
  // px), persisted so a STATIONARY hover survives telemetry ticks -
  // redrawAll passes it back into drawSeries. Without it the crosshair
  // vanished on every tick (the popup stayed, the crosshair flickered out
  // until the next pointermove). Cleared on pointer-leave / collapse.
  hover: { segId: string; x: number; y: number } | null;
}

interface MetricReadout {
  value: string;
  unit: string;
}

interface MetricBinding {
  category: string;
  label: string;
  node: HTMLElement;
  valueNode: HTMLElement;
  unitNode: HTMLElement;
  read: (state: AppState) => MetricReadout;
}

interface FpsBinding {
  category: 'fps';
  label: string;
  node: HTMLElement;
  id: 'fps' | 'frame-time' | 'gpu-busy' | 'average' | 'low-1' | 'low-01' | 'p99';
  valueNode: HTMLElement;
  unitNode: HTMLElement;
}

let mon: MonState | null = null;
let fpsTimer: number | null = null;

// M9: the Monitoring page's sub-view - 'monitoring' = the readout grid +
// canvas graphs, 'overlay' = the overlay settings content. Module-level
// (persists across re-renders - a navigation re-entry must not drop the
// active view, the Tuning pattern); the #/overlay alias + the Settings
// "Overlay settings" button force 'overlay' via consumeOverlayViewRequest
// at render.
let monView: 'monitoring' | 'overlay' = 'monitoring';
let viewContainer: HTMLElement | null = null;

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

function throttleText(sample: TelemetrySample | null): string {
  if (!sample?.throttle) return '-';
  const labels = [
    ['power', 'Power'],
    ['temp', 'Temperature'],
    ['current', 'Current'],
    ['voltage', 'Voltage'],
    ['util', 'Utilization'],
  ] as const;
  const active = labels.filter(([key]) => sample.throttle?.[key]).map(([, label]) => label);
  return active.length > 0 ? active.join(', ') : 'None';
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

function graphKey(deviceId: number, segmentId: string): string {
  return `gpu-${deviceId}-${segmentId}`;
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
): HTMLElement {
  const readout = read(state);
  const valueNode = el('div', { class: 'telemetry-metric-value stat-value', text: readout.value });
  const unitNode = el('div', { class: 'telemetry-metric-unit stat-unit', text: readout.unit });
  const sparkline = seriesId
    ? el('canvas', { class: 'telemetry-metric-sparkline' })
    : el('div', { class: 'telemetry-metric-sparkline telemetry-metric-sparkline-empty', 'aria-hidden': 'true' });
  const node = el('div', { class: `telemetry-metric stat-tile${extraClass ? ` ${extraClass}` : ''}`, dataset: { metricId: `${category}:${label}` } }, [
    el('div', { class: 'telemetry-metric-copy' }, [
      valueNode,
      unitNode,
      el('div', { class: 'telemetry-metric-label stat-label', text: label }),
    ]),
    sparkline,
  ]);
  if (mon) {
    mon.metricBindings.push({ category, label, node, valueNode, unitNode, read });
    if (seriesId && sparkline instanceof HTMLCanvasElement) mon.metricCanvases.set(seriesId, sparkline);
  }
  return node;
}

function cpuMetricNodes(state: AppState): HTMLElement[] {
  return [
    metricNode('Util', (s) => ({ value: statValue(systemSample(s)?.cpuUtilPct), unit: '%' }), state, '', 'cpu'),
    metricNode('Core Frequency', (s) => ({ value: ghzFreq(systemSample(s)?.cpuFreqMhz), unit: 'GHz' }), state, '', 'cpu'),
    metricNode('Temperature', (s) => ({ value: statValue(systemSample(s)?.cpuTempC), unit: '°C' }), state, '', 'cpu'),
    metricNode('Power', (s) => ({ value: statValue(systemSample(s)?.cpuPowerW, 1), unit: 'W' }), state, '', 'cpu'),
  ];
}

function systemMetricNodes(state: AppState): HTMLElement[] {
  return [
    metricNode('RAM in use', (s) => ({ value: memoryGb(systemSample(s)?.memoryUsedBytes), unit: 'GB' }), state, '', 'system-memory'),
    metricNode('RAM capacity', (s) => ({ value: memoryGb(s.sysinfo?.ram.totalBytes), unit: 'GB' }), state, '', 'system-memory'),
  ];
}

function gpuMetricNodes(device: DeviceInfo | null, state: AppState): HTMLElement[] {
  const readSample = (s: AppState): TelemetrySample | null => device ? sampleForDevice(s, device) : systemSample(s);
  const sample = readSample(state);
  const fanCount = Math.max(1, sample?.fanRpm?.length ?? 1);
  const category = device ? `gpu-${device.id}` : 'gpu-vendor';
  const series = (segmentId: string): string | undefined => graphKey(device?.id ?? 0, segmentId);
  const nodes = [
    metricNode('Util', (s) => {
      const v = readSample(s);
      return { value: statValue(v?.gpuUtilPct ?? v?.utilPct), unit: '%' };
    }, state, '', category, series('util')),
    metricNode('Core clock', (s) => ({ value: statValue(readSample(s)?.gpuClockMhz), unit: 'MHz' }), state, '', category, series('clock')),
    metricNode('Voltage', (s) => ({ value: statValue(readSample(s)?.gpuVoltageV, 3), unit: 'V' }), state, '', category),
    metricNode('Temperature', (s) => ({ value: statValue(readSample(s)?.tempC), unit: '°C' }), state, '', category, series('temp')),
    metricNode('Power', (s) => ({ value: statValue(readSample(s)?.powerW, 1), unit: 'W' }), state, '', category, series('power')),
  ];
  for (let fan = 0; fan < fanCount; fan++) {
    nodes.push(metricNode(`Fan ${fan + 1}`, (s) => ({ value: statValue(readSample(s)?.fanRpm?.[fan]), unit: 'RPM' }), state, '', category, fan === 0 ? series('fan') : undefined));
  }
  nodes.push(metricNode('Throttle', (s) => ({ value: throttleText(readSample(s)), unit: '' }), state, '', category));
  return nodes;
}

function gpuMemoryMetricNodes(device: DeviceInfo | null, state: AppState): HTMLElement[] {
  const readSample = (s: AppState): TelemetrySample | null => device ? sampleForDevice(s, device) : systemSample(s);
  const category = device ? `gpu-memory-${device.id}` : 'gpu-memory-vendor';
  return [
    metricNode('VRAM in use', (s) => {
      const v = readSample(s);
      return { value: formatGpuMemoryGb(v?.gpuMemUsedBytes), unit: gpuMemoryLabel(v?.gpuMemorySource) === 'VRAM' ? 'GB' : 'GB shared' };
    }, state, '', category),
    metricNode('Memory clock', (s) => ({ value: statValue(readSample(s)?.memClockMhz), unit: 'MHz' }), state, '', category),
    metricNode('VramTemp', (s) => ({ value: statValue(readSample(s)?.vramTempC), unit: '°C' }), state, '', category),
  ];
}

function latencyMetricNodes(state: AppState): HTMLElement[] {
  return [
    // The current FPS adapters expose frame time, not a measured end-to-end
    // input/render/present latency. Keep this honest until that source exists.
    metricNode('Render latency', () => ({ value: '-', unit: 'ms' }), state, '', 'latency'),
  ];
}

function fpsMetricNode(label: string, id: FpsBinding['id'], unit: string): HTMLElement {
  const valueNode = el('div', { class: 'telemetry-metric-value stat-value', text: '-' });
  const unitNode = el('div', { class: 'telemetry-metric-unit stat-unit', text: unit });
  const node = el('div', { class: `telemetry-metric stat-tile${id === 'fps' ? ' mon-fps-tile' : ''}`, dataset: { metricId: `fps:${label}` } }, [
    el('div', { class: 'telemetry-metric-copy' }, [
      valueNode,
      unitNode,
      el('div', { class: 'telemetry-metric-label stat-label', text: label }),
    ]),
    el('div', { class: 'telemetry-metric-sparkline telemetry-metric-sparkline-empty', 'aria-hidden': 'true' }),
  ]);
  if (mon) mon.fpsBindings.push({ category: 'fps', label, node, id, valueNode, unitNode });
  return node;
}

function refreshFpsMetrics(sample: FpsSample | null): void {
  if (!mon) return;
  const values: Record<FpsBinding['id'], { value: string; unit: string }> = {
    fps: { value: statValue(sample?.fps), unit: 'FPS' },
    'frame-time': { value: statValue(sample?.frameTimeMs, 1), unit: 'ms' },
    'gpu-busy': { value: statValue(sample?.gpuBusy), unit: '%' },
    average: { value: statValue(sample?.avgFps), unit: 'FPS' },
    'low-1': { value: statValue(sample?.low1Pct), unit: 'FPS' },
    'low-01': { value: statValue(sample?.low01Pct), unit: 'FPS' },
    p99: { value: statValue(sample?.p99), unit: 'FPS' },
  };
  for (const binding of mon.fpsBindings) {
    binding.valueNode.textContent = values[binding.id].value;
    binding.unitNode.textContent = values[binding.id].unit;
  }
}

/** AMD-style compact history strip for the readout rows. The larger trend
 * inspector below keeps the detailed grid/hover experience; these strips are
 * intentionally quiet so the current value remains the visual focus. */
function drawMiniSeries(canvas: HTMLCanvasElement, points: SeriesPoint[]): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const bg = cssVar('--bg-inset');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  if (points.length === 0) return;
  const scale = autoScale(points);
  if (!scale) return;
  const drawn = downsample(points, 72);
  const span = scale.max - scale.min;
  const x = (index: number): number => drawn.length <= 1 ? w / 2 : (index / (drawn.length - 1)) * (w - 4) + 2;
  const y = (value: number): number => span <= 0 ? h / 2 : 3 + (1 - (value - scale.min) / span) * Math.max(4, h - 6);
  const accent = cssVar('--accent');
  ctx.beginPath();
  drawn.forEach((point, index) => {
    const px = x(index);
    const py = y(point.v);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.lineTo(w - 2, h - 2);
  ctx.lineTo(2, h - 2);
  ctx.closePath();
  ctx.fillStyle = accent;
  ctx.globalAlpha = .22;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  drawn.forEach((point, index) => {
    const px = x(index);
    const py = y(point.v);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

/**
 * Thin Canvas 2D draw: grid + min/max labels + the downsampled polyline.
 * Pure data in, pixels out - no math of consequence lives here.
 * M4-C: an optional `crosshair` ({x, y} in CSS pixels, from the nearest
 * sample of a hover) draws the dashed crosshair + a dot on the sample.
 */
function drawSeries(canvas: HTMLCanvasElement, points: SeriesPoint[], crosshair: { x: number; y: number } | null = null): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const scale = autoScale(points);
  if (!scale) {
    ctx.fillStyle = cssVar('--text-dim');
    ctx.font = '11px system-ui';
    ctx.fillText('Waiting for telemetry…', 8, 18);
    return;
  }

  const padL = 42;
  const padR = 8;
  const padT = 8;
  const padB = 16;
  const pw = Math.max(10, w - padL - padR);
  const ph = Math.max(10, h - padT - padB);
  const span = scale.max - scale.min;
  const y = (v: number): number => padT + (1 - (v - scale.min) / span) * ph;
  const tMin = points[0].t;
  const tMax = points[points.length - 1].t;
  const tSpan = tMax - tMin > 0 ? tMax - tMin : GRAPH_WINDOW_S;
  const x = (t: number): number => padL + ((t - tMin) / tSpan) * pw;

  const dim = cssVar('--text-dim');
  const border = cssVar('--border');
  const accent = cssVar('--accent');

  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.font = '10px system-ui';
  ctx.fillStyle = dim;
  for (let i = 0; i <= 4; i++) {
    const gy = padT + (ph / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(w - padR, gy);
    ctx.stroke();
    const gv = scale.max - (span / 4) * i;
    ctx.fillText(`${gv.toFixed(gv >= 100 ? 0 : 1)}`, 2, gy + 3);
  }
  ctx.fillText(`${tSpan.toFixed(0)}s`, padL, h - 4);

  const drawn = downsample(points, DRAW_MAX_POINTS);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  drawn.forEach((p, i) => {
    const px = x(p.t);
    const py = y(p.v);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // M4-C: the hover crosshair - dashed cross lines through the nearest
  // sample + a dot on the sample itself.
  if (crosshair) {
    ctx.strokeStyle = dim;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(crosshair.x, padT);
    ctx.lineTo(crosshair.x, h - padB);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(padL, crosshair.y);
    ctx.lineTo(w - padR, crosshair.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(crosshair.x, crosshair.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
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
  setLatestFps(sample?.fps ?? null);
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
      canvases: new Map(),
      metricCanvases: new Map(),
      fpsTileValue: null,
      fpsNote: null,
      metricBindings: [],
      fpsBindings: [],
      hover: null,
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
          : 'Live values and 60-second rolling graphs from the GPU.',
      }),
      viewToggle,
      viewContainer,
    );
    // M9: the view switch re-renders ONLY the sub-view container - the
    // telemetry series (module-level mon.series) survive the round trip,
    // and every monitoring-view rebuild re-registers the canvases + the
    // FPS tile + the note (the S2 contract in renderMonitoringView).
    const renderMonView = (): void => {
      if (!viewContainer) return;
      if (monView === 'overlay') {
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
    mon = null;
  },

  onUpdate(container: HTMLElement, ctx: PageContext) {
    if (!mon) return;
    const state = ctx.store.get();
    const telemetryDevices: Array<DeviceInfo | null> = state.devices.length > 0 ? state.devices : [null];
    for (const device of telemetryDevices) {
      const sample = device ? sampleForDevice(state, device) : systemSample(state);
      const now = sample?.t ?? Date.now();
      for (const seg of SEGMENTS) {
        const value = seg.value(sample);
        if (value !== undefined) {
          const key = graphKey(device?.id ?? 0, seg.id);
          // The real driver's telemetry timestamp can occasionally tick
          // backwards. Sorting before drawing prevents a folded polyline.
          mon.series[key] = trimSeriesWindow(
            sortSeriesByTime(pushSeries(mon.series[key] ?? [], sample?.t ?? now, value)),
            now,
            GRAPH_WINDOW_S,
          );
        }
      }
    }
    updateMetricBindings(state);
    redrawAll();
  },
};

/** M9: the monitoring sub-view build - the readout grid + the canvas
 *  segments (the old render() body, extracted so the view switch can
 *  rebuild it). THE RE-REGISTRATION CONTRACT (plan-review S2): every
 *  (re)build re-registers mon.canvases, mon.fpsTileValue and mon.fpsNote,
 *  so pollFps + redrawAll always write into the LIVE view and never into
 *  the detached nodes a clear(viewContainer) orphans (a re-shown view
 *  would otherwise show a frozen FPS tile + empty graphs). */
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
  node: HTMLElement;
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
    const toggle = el('button', {
      class: 'telemetry-tracking-toggle active',
      type: 'button',
      'aria-pressed': 'true',
      title: `Show or hide ${entry.label}`,
      onClick: () => {
        const active = entry.node.hidden;
        entry.node.hidden = !active;
        toggle.classList.toggle('active', active);
        toggle.setAttribute('aria-pressed', String(active));
        toggle.querySelector('.telemetry-tracking-toggle-state')!.textContent = active ? 'On' : 'Off';
      },
    }, [
      el('span', { class: 'telemetry-tracking-option-label', text: entry.label }),
      el('span', { class: 'telemetry-tracking-toggle-state', text: 'On' }),
    ]);
    body.append(el('div', { class: 'telemetry-tracking-option' }, [el('span', { class: 'telemetry-tracking-option-mark', text: '•' }), el('span', { class: 'telemetry-tracking-option-copy' }, [el('span', { text: entry.label })]), toggle]));
  }
  return el('section', { class: 'telemetry-tracking-group', dataset: { trackingGroup: key } }, [head, body]);
}

function renderTrackingPanel(state: AppState): HTMLElement {
  if (!mon) return el('aside', { class: 'card telemetry-tracking-card' });
  const byCategory = new Map<string, TrackingEntry[]>();
  const add = (category: string, label: string, node: HTMLElement): void => {
    const list = byCategory.get(category) ?? [];
    list.push({ label, node });
    byCategory.set(category, list);
  };
  mon.metricBindings.forEach((binding) => add(binding.category, binding.label, binding.node));
  mon.fpsBindings.forEach((binding) => add(binding.category, binding.label, binding.node));
  const groups: Array<{ key: string; title: string; subtitle: string }> = [
    { key: 'fps', title: 'FPS', subtitle: 'Frame pacing' },
    { key: 'latency', title: 'Latency', subtitle: 'Render timing' },
    { key: 'cpu', title: 'CPU', subtitle: 'Processor' },
    { key: 'system-memory', title: 'System Memory', subtitle: 'RAM' },
  ];
  state.devices.forEach((device, index) => {
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
  return el('aside', { class: 'card telemetry-tracking-card' }, [
    el('div', { class: 'telemetry-tracking-heading' }, [
      el('div', {}, [el('h2', { class: 'card-title', text: 'Tracking' }), el('p', { class: 'card-note', text: 'Choose which readouts stay visible.' })]),
      el('span', { class: 'telemetry-tracking-live', text: 'Live' }),
    ]),
    logButton,
    el('div', { class: 'telemetry-sampling-row' }, [
      el('span', { text: 'Sampling interval' }),
      el('strong', { text: '1 s' }),
    ]),
    el('div', { class: 'telemetry-tracking-label', text: 'Select metrics' }),
    list,
  ]);
}

function renderMonitoringView(container: HTMLElement, ctx: PageContext): void {
  const m = mon;
  if (!m) return;
  clear(container);
  const s = ctx.store.get();
  m.canvases = new Map();
  m.metricCanvases = new Map();
  m.metricBindings = [];
  m.fpsBindings = [];
  const fpsNote = el('p', { class: 'card-note mon-fps-note', text: FPS_CHECKING_NOTE });
  m.fpsNote = fpsNote;

  const monitoringSummary = el('div', { class: 'monitoring-summary-strip' }, [
    el('div', { class: 'monitoring-summary-live' }, [el('span', { class: 'status-dot status-ok' }), el('strong', { text: 'Live telemetry' })]),
    el('span', { class: 'monitoring-summary-note', text: '60-second rolling window · hover a graph for detail' }),
  ]);

  const panels = el('div', { class: 'telemetry-metrics' });
  panels.append(
    telemetryPanel('fps', 'FPS & frame pacing', 'Display output', [
      fpsMetricNode('Frame rate', 'fps', 'FPS'),
      fpsMetricNode('Frame time', 'frame-time', 'ms'),
      fpsMetricNode('GPU busy', 'gpu-busy', '%'),
      fpsMetricNode('Average', 'average', 'FPS'),
      fpsMetricNode('1% low', 'low-1', 'FPS'),
      fpsMetricNode('0.1% low', 'low-01', 'FPS'),
      fpsMetricNode('P99', 'p99', 'FPS'),
    ], true, 'mon-readout-fps'),
    telemetryPanel('latency', 'Latency', 'Unavailable', latencyMetricNodes(s), true, 'mon-readout-latency'),
    telemetryPanel('cpu', 'CPU', 'System', cpuMetricNodes(s), true, 'mon-readout-cpu'),
    telemetryPanel('system-memory', 'System memory', 'System', systemMetricNodes(s), true, 'mon-readout-system-memory'),
  );
  s.devices.forEach((device, index) => {
    const label = `GPU ${index + 1}`;
    const badge = device.displayActive === true ? `${shortGpuName(device)} · Display output` : shortGpuName(device);
    panels.append(telemetryPanel(`gpu-${device.id}`, label, badge, gpuMetricNodes(device, s), true, index === 0 ? 'mon-readout-gpu' : `mon-readout-gpu-${index + 1}`));
    panels.append(telemetryPanel(`gpu-memory-${device.id}`, `${label} memory`, badge, gpuMemoryMetricNodes(device, s), true, index === 0 ? 'mon-readout-gpu-memory' : `mon-readout-gpu-memory-${index + 1}`));
  });
  if (s.devices.length === 0 && s.osGpu) {
    const badge = shortGpuNameFromName(s.osGpu.name);
    panels.append(telemetryPanel('gpu-vendor', 'GPU', badge, gpuMetricNodes(null, s), true, 'mon-readout-gpu'));
    panels.append(telemetryPanel('gpu-memory-vendor', 'GPU memory', badge, gpuMemoryMetricNodes(null, s), true, 'mon-readout-gpu-memory'));
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

  const graphDevices: Array<DeviceInfo | null> = s.devices.length > 0 ? s.devices : [null];
  const graphEntries = graphDevices.flatMap((device, deviceIndex) => SEGMENTS.map((seg) => ({ device, deviceIndex, seg })));
  const graphs = el('section', { class: 'seg-stack telemetry-trend-stack' }, graphEntries.map(({ device, deviceIndex, seg }) => {
    const seriesId = graphKey(device?.id ?? 0, seg.id);
    const canvas = el('canvas', { class: 'seg-canvas' });
    m.canvases.set(seriesId, canvas);
    const popup = el('div', { class: 'seg-popup', hidden: true });
    // Keep the canvas and its absolutely-positioned popup inside one grid
    // child.  With two direct children, the collapsed grid only removed the
    // first implicit row and left a visible popup row behind.
    const bodyInner = el('div', { class: 'seg-body-inner' }, [canvas, popup]);
    const body = el('div', { class: 'seg-body is-collapsed', 'aria-hidden': 'true' }, [bodyInner]);
    const head = el('button', {
      class: 'seg-head',
      'aria-expanded': 'false',
      onClick: () => {
        const collapsed = body.classList.contains('is-collapsed');
        body.classList.toggle('is-collapsed', !collapsed);
        body.setAttribute('aria-hidden', String(collapsed));
        head.setAttribute('aria-expanded', String(collapsed));
        head.querySelector('.seg-chevron')!.textContent = collapsed ? '▾' : '▸';
        // M4-C: collapsing the segment hides any stale hover popup and
        // clears the persisted crosshair.
        if (!collapsed) {
          popup.hidden = true;
          if (mon) mon.hover = null;
        }
        drawSeries(canvas, mon?.series[seriesId] ?? []);
      },
    }, [
      el('span', { class: 'seg-chevron', text: '▸' }),
      el('span', { class: 'seg-label', text: `GPU ${deviceIndex + 1} · ${seg.label}` }),
      el('span', { class: 'seg-source', text: device ? shortGpuName(device) : shortGpuNameFromName(s.osGpu?.name) }),
      el('span', { class: 'seg-unit', text: seg.unit }),
    ]);
    // All segments are collapsed by default; expanding one draws its current
    // series and keeps the initial monitoring paint compact.
    // M4-C: hover crosshair + nearest-sample popup - only while the
    // segment is EXPANDED (the collapsed body is visually closed, and the handler
    // re-checks so a collapse mid-hover can never leave a popup behind).
    const hideHover = () => {
      popup.hidden = true;
      if (mon) mon.hover = null;
      drawSeries(canvas, mon?.series[seriesId] ?? []);
    };
    canvas.addEventListener('pointermove', (ev) => {
      if (body.classList.contains('is-collapsed')) return;
      const points = mon?.series[seriesId] ?? [];
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0 || points.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      const padL = 42;
      const padR = 8;
      const padT = 8;
      const padB = 16;
      const pw = Math.max(10, w - padL - padR);
      const xNorm = (ev.clientX - rect.left - padL) / pw;
      const idx = nearestSampleIndex(points, xNorm);
      if (idx < 0) return;
      const p = points[idx];
      const scale = autoScale(points);
      if (!scale) return;
      const ph = Math.max(10, h - padT - padB);
      const span = scale.max - scale.min;
      const x = padL + xNorm * pw;
      const y = padT + (1 - (p.v - scale.min) / span) * ph;
      // Relative time against the newest sample in the drawn window.
      const nowT = points[points.length - 1].t;
      popup.textContent = `${Math.round(p.v)} ${seg.unit} · ${Math.round(nowT - p.t)} s ago`;
      // The canvas starts at the body's padding box + 10px/8px padding.
      // M4-C (round-2 fix): the popup must stay FULLY inside the card -
      // the old unclamped `left: 10 + x` (x reaches w - 8 at the canvas's
      // right edge) centered the ~120px box up to ~60px past the card's
      // right edge, and .seg-card{overflow:hidden} clipped the "· N s
      // ago" tail - and the rightmost ~5 s of the graph is where the
      // NEWEST sample (the common hover) sits. Top-edge samples
      // (v = max -> y = padT = 8) parked the box ~12px above the canvas,
      // over the segment header. Mirror the fan readout's round-1 fix:
      // measure the segment body + box, clamp horizontally in px so the
      // box never leaves the card, and flip BELOW the sample (the
      // .seg-popup-below class) when there is no room above. The
      // %-positioned default stays as the fallback when the body cannot
      // be measured.
      popup.hidden = false;
      const bodyEl = popup.parentElement;
      const br = bodyEl ? bodyEl.getBoundingClientRect() : null;
      if (br && br.width > 0 && br.height > 0) {
        const box = popup.getBoundingClientRect();
        const px = 10 + x;
        const py = 8 + y;
        const flipBelow = py - 6 - box.height < 0 && py + 10 + box.height <= br.height;
        popup.classList.toggle('seg-popup-below', flipBelow);
        // The inner graph wrapper can be wider than the visible card while a
        // responsive grid is settling. Clamp in viewport space against the
        // card itself, then convert the final center back to the popup's
        // containing block; this prevents the newest-sample tooltip from
        // escaping through the right edge.
        const cardRect = bodyEl?.closest('.seg-card')?.getBoundingClientRect() ?? br;
        const desiredCenter = br.left + px;
        const minCenter = cardRect.left + box.width / 2 + 2;
        const maxCenter = cardRect.right - box.width / 2 - 2;
        const center = Math.min(Math.max(desiredCenter, minCenter), Math.max(minCenter, maxCenter));
        popup.style.left = `${center - br.left}px`;
        popup.style.top = `${py}px`;
      } else {
        popup.classList.remove('seg-popup-below');
        popup.style.left = `${10 + x}px`;
        popup.style.top = `${8 + y}px`;
      }
      // M4-C (round-1 fix): persist the hover so redrawAll can re-draw
      // the crosshair on telemetry ticks (a stationary hover used to lose
      // it every second while the popup stayed).
      if (mon) mon.hover = { segId: seriesId, x, y };
      drawSeries(canvas, points, { x, y });
    });
    canvas.addEventListener('pointerleave', hideHover);
    return el('div', { class: 'card seg-card' }, [head, body]);
  }));

  const trends = el('section', { class: 'telemetry-trends card' }, [
    el('div', { class: 'telemetry-section-heading' }, [
      el('div', {}, [el('h2', { class: 'card-title', text: 'Trends' }), el('p', { class: 'card-note', text: 'GPU history over the last 60 seconds. Expand a signal to inspect it.' })]),
      el('span', { class: 'telemetry-live-badge telemetry-live-badge-muted', text: `${graphEntries.length} signals` }),
    ]),
    graphs,
  ]);

  const workspace = el('div', { class: 'monitoring-workspace' }, [
    el('main', { class: 'monitoring-metrics-column' }, [monitoringSummary, readout]),
    renderTrackingPanel(s),
  ]);
  container.append(workspace, trends);
  redrawAll();
}

function redrawAll(): void {
  if (!mon) return;
  for (const [id, canvas] of mon.metricCanvases) {
    drawMiniSeries(canvas, mon.series[id] ?? []);
  }
  for (const [id, canvas] of mon.canvases) {
    // M4-C (round-1 fix): pass the persisted hover crosshair through every
    // redraw - without it a stationary hover lost the crosshair on each
    // telemetry tick (the popup stayed but the crosshair vanished until the
    // next pointermove).
    const crosshair = mon.hover && mon.hover.segId === id ? { x: mon.hover.x, y: mon.hover.y } : null;
    drawSeries(canvas, mon.series[id] ?? [], crosshair);
  }
}

/**
 * 1.0.1 (N9): redraw the canvases NOW - a theme switch recolors the graphs
 * immediately (drawSeries reads the CSS vars at draw time; without this
 * hook the graphs would keep the old palette until the next telemetry
 * tick). No-op when the Monitoring page is not mounted.
 */
export function redrawMonitoringGraphs(): void {
  redrawAll();
}
