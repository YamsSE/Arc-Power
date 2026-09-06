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
  pushSeries,
  trimSeriesWindow,
  sortSeriesByTime,
  autoScale,
  downsample,
  GRAPH_WINDOW_S,
} from '../pure/graph.ts';
import type { SeriesPoint } from '../pure/graph.ts';

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
  metricCanvases: Map<string, HTMLCanvasElement>;
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
const miniCanvasLayouts = new WeakMap<HTMLCanvasElement, { width: number; height: number; dpr: number }>();

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

function systemGraphKey(segmentId: string): string {
  return `system-${segmentId}`;
}

function fpsGraphKey(id: FpsBinding['id']): string {
  return `fps-${id}`;
}

function pushMetricSeries(seriesId: string, t: number, value: number | undefined): void {
  if (!mon || value === undefined || !Number.isFinite(value)) return;
  mon.series[seriesId] = trimSeriesWindow(
    sortSeriesByTime(pushSeries(mon.series[seriesId] ?? [], t, value)),
    t,
    GRAPH_WINDOW_S,
  );
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
  const node = el('div', { class: `telemetry-metric stat-tile${extraClass ? ` ${extraClass}` : ''}`, dataset: { metricId: `${category}:${label}` } }, [
    el('div', { class: 'telemetry-metric-copy' }, [
      valueNode,
      unitNode,
      el('div', { class: 'telemetry-metric-label stat-label', text: label }),
    ]),
    sparkline,
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
  const series = (segmentId: string): string | undefined => graphKey(device?.id ?? 0, segmentId);
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
      }, state, '', category, graphKey(device?.id ?? 0, 'vram'), 'gpu-shared-memory'),
    ];
  }
  return [
    metricNode('VRAM in use', (s) => {
      const v = readSample(s);
      return { value: formatGpuMemoryGb(v?.gpuMemUsedBytes), unit: gpuMemoryLabel(v?.gpuMemorySource) === 'VRAM' ? 'GB' : 'GB shared' };
    }, state, '', category, graphKey(device?.id ?? 0, 'vram'), 'gpu-vram'),
    metricNode('Memory clock', (s) => ({ value: statValue(readSample(s)?.memClockMhz), unit: 'MHz' }), state, '', category, graphKey(device?.id ?? 0, 'mem-clock'), 'gpu-memory-clock'),
    metricNode('VramTemp', (s) => ({ value: statValue(readSample(s)?.vramTempC), unit: '°C' }), state, '', category, graphKey(device?.id ?? 0, 'vram-temp'), 'gpu-vram-temperature'),
  ];
}

function fpsMetricNode(label: string, id: FpsBinding['id'], unit: string): HTMLElement {
  const valueNode = el('div', { class: 'telemetry-metric-value stat-value', text: '-' });
  const unitNode = el('div', { class: 'telemetry-metric-unit stat-unit', text: unit });
  const seriesId = fpsGraphKey(id);
  const node = el('div', { class: `telemetry-metric stat-tile${id === 'fps' ? ' mon-fps-tile' : ''}`, dataset: { metricId: `fps:${label}` } }, [
    el('div', { class: 'telemetry-metric-copy' }, [
      valueNode,
      unitNode,
      el('div', { class: 'telemetry-metric-label stat-label', text: label }),
    ]),
    el('canvas', { class: 'telemetry-metric-sparkline' }),
  ]);
  if (mon) {
    mon.fpsBindings.push({ category: 'fps', label, node, id, seriesId, valueNode, unitNode });
    const canvas = node.querySelector('canvas');
    if (canvas instanceof HTMLCanvasElement) mon.metricCanvases.set(seriesId, canvas);
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

/** AMD-style compact history strip for each readout row. */
function drawMiniSeries(canvas: HTMLCanvasElement, points: SeriesPoint[]): void {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = Math.round(canvas.clientWidth);
  const h = Math.round(canvas.clientHeight);
  if (w <= 0 || h <= 0) return;
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
      metricCanvases: new Map(),
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
          : 'Live values and 60-second rolling graphs from the GPU.',
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
    if (graphRedrawFrame !== null) {
      window.cancelAnimationFrame(graphRedrawFrame);
      graphRedrawFrame = null;
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
      const t = now > 10_000_000_000 ? now / 1000 : now;
      const id = device?.id ?? 0;
      pushMetricSeries(graphKey(id, 'util'), t, sample?.gpuUtilPct ?? sample?.utilPct);
      pushMetricSeries(graphKey(id, 'clock'), t, sample?.gpuClockMhz);
      pushMetricSeries(graphKey(id, 'voltage'), t, sample?.gpuVoltageV);
      pushMetricSeries(graphKey(id, 'temp'), t, sample?.tempC);
      pushMetricSeries(graphKey(id, 'power'), t, sample?.powerW);
      pushMetricSeries(graphKey(id, 'fan'), t, sample?.fanRpm?.[0]);
      pushMetricSeries(graphKey(id, 'vram'), t, sample?.gpuMemUsedBytes === null || sample?.gpuMemUsedBytes === undefined
        ? undefined
        : sample.gpuMemUsedBytes / 1e9);
      pushMetricSeries(graphKey(id, 'mem-clock'), t, sample?.memClockMhz);
      pushMetricSeries(graphKey(id, 'vram-temp'), t, sample?.vramTempC);
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

function renderMonitoringView(container: HTMLElement, ctx: PageContext): void {
  const m = mon;
  if (!m) return;
  clear(container);
  const s = ctx.store.get();
  m.metricCanvases = new Map();
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
    el('main', { class: 'monitoring-metrics-column' }, [monitoringSummary, readout]),
    renderTrackingPanel(s),
  ]);
  container.append(workspace);
  redrawAll();
}

function redrawAll(): void {
  if (!mon || graphRedrawFrame !== null) return;
  // A telemetry push is emitted once per adapter, so a multi-GPU machine can
  // deliver multiple store updates in one paint interval. Coalesce those
  // updates into one frame so graphs never render an intermediate snapshot.
  graphRedrawFrame = window.requestAnimationFrame(() => {
    graphRedrawFrame = null;
    if (!mon) return;
    for (const [id, canvas] of mon.metricCanvases) {
      drawMiniSeries(canvas, mon.series[id] ?? []);
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
  redrawAll();
}
