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
import { healthRows, overallHealthLevel, dashboardNeedsFullRender } from '../pure/status.ts';
import type { DashboardSig, HealthLevel, HealthRow } from '../pure/status.ts';
import { ensureWaiver } from '../components/waiver-dialog.ts';
import { buildDeviceSelect } from '../components/device-select.ts';
import { selectDevice } from '../app.ts';
import { decodeDriverVersion, formatDriverDate, shaderUnits } from '../pure/driver.ts';
import { cpuCardRows, rebarState, vramRowValue } from '../pure/sysinfo.ts';
import { formatGpuMemoryGb } from '../pure/gpu-memory.ts';
import { cpuIconKeyOf, cpuIconPath, gpuIconKeyOf, gpuIconPath } from '../pure/hardware-icons.ts';
import { selectedDashboardController } from '../pure/dashboard.ts';
import { aibOfPnpDeviceId } from '../pure/aib.ts';
import type { TelemetrySample } from '../types.ts';

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
  { id: 'gpu-util', label: 'GPU utilization', unit: '%', color: '#43c7ff' },
  { id: 'temperature', label: 'GPU temperature', unit: '°C', color: '#f2b15b' },
  { id: 'power', label: 'GPU power', unit: 'W', color: '#b995ff' },
  { id: 'vram', label: 'VRAM in use', unit: 'GB', color: '#55d6a5' },
];

const DASHBOARD_HISTORY_LIMIT = 60;
let dashboardHistory: TelemetrySample[] = [];
let dashboardHistoryDeviceId: number | null | undefined;
let dashboardSessionStartedAt = Date.now();
const pulseValueNodes = new Map<DashboardPulseId, HTMLElement>();
const pulsePathNodes = new Map<DashboardPulseId, SVGPathElement>();
let sessionRuntimeNode: HTMLElement | null = null;
let sessionPeakNode: HTMLElement | null = null;
let sessionAverageNode: HTMLElement | null = null;
type DashboardSnapshotId = 'gpu' | 'driver' | 'tuning' | 'rebar' | 'vram' | 'capture';
const snapshotValueNodes = new Map<DashboardSnapshotId, HTMLElement>();
let snapshotHealthNode: HTMLElement | null = null;

function resetDashboardHistory(deviceId: number | null): void {
  if (dashboardHistoryDeviceId === deviceId) return;
  dashboardHistoryDeviceId = deviceId;
  dashboardHistory = [];
  dashboardSessionStartedAt = Date.now();
}

function rememberDashboardSample(sample: TelemetrySample | null, deviceId: number | null): void {
  if (!sample) return;
  if (sample.deviceId !== undefined && sample.deviceId !== null && sample.deviceId !== deviceId) return;
  const last = dashboardHistory[dashboardHistory.length - 1];
  if (last && last.t === sample.t && last.deviceId === sample.deviceId) return;
  dashboardHistory = [...dashboardHistory, sample].slice(-DASHBOARD_HISTORY_LIMIT);
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

function pulseHistoryValues(id: DashboardPulseId): number[] {
  return dashboardHistory
    .map((sample) => pulseSampleValue(id, sample))
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function updatePulsePath(id: DashboardPulseId): void {
  const path = pulsePathNodes.get(id);
  if (!path) return;
  const values = pulseHistoryValues(id);
  if (values.length < 2) {
    path.setAttribute('d', 'M 0 16 L 120 16');
    return;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(0.001, max - min);
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 120;
    const y = 28 - ((value - min) / span) * 22;
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  path.setAttribute('d', `M ${points.join(' L ')}`);
}

function formatSessionAge(): string {
  const totalSeconds = Math.max(0, Math.floor((Date.now() - dashboardSessionStartedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, '0')}m`
    : `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function updateSessionStats(): void {
  const temps = pulseHistoryValues('temperature');
  const utils = pulseHistoryValues('gpu-util');
  if (sessionRuntimeNode) sessionRuntimeNode.textContent = formatSessionAge();
  if (sessionPeakNode) sessionPeakNode.textContent = temps.length ? `${Math.round(Math.max(...temps))} °C` : '-';
  if (sessionAverageNode) sessionAverageNode.textContent = utils.length
    ? `${Math.round(utils.reduce((sum, value) => sum + value, 0) / utils.length)} %`
    : '-';
}

function updateDashboardPulse(ctx: PageContext): void {
  const state = ctx.store.get();
  resetDashboardHistory(state.deviceId);
  rememberDashboardSample(state.latestSample, state.deviceId);
  for (const metric of DASHBOARD_PULSE) {
    const valueNode = pulseValueNodes.get(metric.id);
    if (valueNode) valueNode.textContent = pulseDisplayValue(metric.id, state.latestSample);
    updatePulsePath(metric.id);
  }
  updateSessionStats();
}

function dashboardPulse(ctx: PageContext): HTMLElement {
  const state = ctx.store.get();
  resetDashboardHistory(state.deviceId);
  rememberDashboardSample(state.latestSample, state.deviceId);
  pulseValueNodes.clear();
  pulsePathNodes.clear();
  sessionRuntimeNode = null;
  sessionPeakNode = null;
  sessionAverageNode = null;

  const selectedDevice = state.devices.find((device) => device.id === state.deviceId);
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
      'aria-label': `${metric.label} history`,
    });
    svg.append(path);
    const valueNode = el('strong', { class: 'dashboard-pulse-value', text: pulseDisplayValue(metric.id, state.latestSample) });
    pulseValueNodes.set(metric.id, valueNode);
    pulsePathNodes.set(metric.id, path);
    const card = el('div', { class: 'dashboard-pulse-metric', dataset: { pulseMetric: metric.id } }, [
      el('div', { class: 'dashboard-pulse-metric-head' }, [
        el('span', { class: 'dashboard-pulse-label', text: metric.label }),
        el('span', { class: 'dashboard-pulse-unit', text: metric.unit }),
      ]),
      el('div', { class: 'dashboard-pulse-value-row' }, [valueNode, el('span', { class: 'dashboard-pulse-live-dot', title: 'Live telemetry' })]),
      svg,
    ]);
    updatePulsePath(metric.id);
    return card;
  });

  sessionRuntimeNode = el('strong', { text: formatSessionAge() });
  sessionPeakNode = el('strong', { text: '-' });
  sessionAverageNode = el('strong', { text: '-' });
  const sessionStats = el('div', { class: 'dashboard-session-stats' }, [
    el('span', { class: 'dashboard-session-title', text: 'Since launch' }),
    el('span', { class: 'dashboard-session-stat' }, [el('span', { text: 'Session' }), sessionRuntimeNode]),
    el('span', { class: 'dashboard-session-stat' }, [el('span', { text: 'Peak temp' }), sessionPeakNode]),
    el('span', { class: 'dashboard-session-stat' }, [el('span', { text: 'Average GPU' }), sessionAverageNode]),
  ]);
  updateSessionStats();

  return el('section', { class: 'card dashboard-pulse-card' }, [
    el('div', { class: 'dashboard-pulse-heading' }, [
      el('div', {}, [
        el('span', { class: 'dashboard-eyebrow', text: 'Live telemetry' }),
        el('h2', { class: 'card-title', text: 'Performance pulse' }),
      ]),
      el('span', { class: `dashboard-pulse-device${selectedDevice ? '' : ' text-unknown' }`, text: selectedDevice?.name ?? 'No GPU selected' }),
    ]),
    el('div', { class: 'dashboard-pulse-grid' }, pulseCards),
    sessionStats,
  ]);
}

function dashboardAction(label: string, hash: string): HTMLElement {
  return el('a', { class: 'dashboard-quick-action', href: hash, text: label });
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
    class: `hardware-card-icon hardware-card-icon-${kind}`,
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

  return el('section', { class: 'card health-card' }, [
    el('h2', { class: 'card-title', text: 'GPU Status' }),
    el('div', { class: 'card-body' }, rows.map((row) => healthRowEl(row, ctx))),
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
  if (status.running) {
    return status.mode === 'replay'
      ? { value: 'Replay buffer', note: 'Capturing the rolling clip window' }
      : { value: 'Recording', note: 'Arc Capture is active' };
  }
  if (status.available) return { value: 'Ready', note: 'Ready when you are' };
  return { value: 'Unavailable', note: 'Capture engine is unavailable' };
}

function dashboardSnapshotState(ctx: PageContext): { health: HealthLevel; healthLabel: string; values: Record<DashboardSnapshotId, { value: string; note: string }> } {
  const s = ctx.store.get();
  const device = s.devices.find((entry) => entry.id === s.deviceId) ?? null;
  const osOnly = device?.synthetic === true && device.backendKind === 'os';
  const noIntelPresentation = s.noIntel || osOnly;
  const controller = selectedDashboardController(device?.osController, s.osGpu, s.deviceId !== null);
  const rebar = rebarState(controller ? { ...controller, rebarActive: controller.rebarActive ?? null } : null);
  const rows = dashboardHealthRows(ctx, device, osOnly);
  const driverRow = rows.find((row) => row.id === 'driver');
  const ocRow = rows.find((row) => row.id === 'oc');
  const rawDriver = noIntelPresentation ? controller?.driverVersion : device?.driverVersion;
  const decodedDriver = decodeDriverVersion(rawDriver);
  const driverDate = formatDriverDate(s.driverDate);
  const driver = decodedDriver ? `${decodedDriver}${driverDate ? ` · ${driverDate}` : ''}` : driverRow?.detail ?? '-';
  const vramBytes = noIntelPresentation ? (s.vendorInfo?.vramBytes ?? s.osGpu?.vramBytes) : device?.vramBytes;
  const tuning = ocRow?.level === 'ok'
    ? ocRow.detail === 'No Overclock Applied' ? 'Stock' : 'Custom'
    : ocRow?.detail ?? 'Unknown';
  const health = overallHealthLevel(rows);
  const healthLabel = health === 'ok' ? 'Healthy' : health === 'warn' ? 'Check status' : health === 'error' ? 'Needs attention' : 'Waiting';
  return {
    health,
    healthLabel,
    values: {
      gpu: { value: noIntelPresentation ? (s.osGpu?.name ?? 'No GPU selected') : (device?.name ?? 'No GPU selected'), note: 'Active adapter' },
      driver: { value: driver, note: 'Display driver' },
      tuning: { value: tuning, note: 'Current driver state' },
      rebar: { value: rebar.label, note: 'PCIe memory access' },
      vram: { value: vramBytes ? `${formatGpuMemoryGb(vramBytes)} GB` : '-', note: 'Dedicated capacity' },
      capture: snapshotCaptureState(s.recordingStatus),
    },
  };
}

function dashboardSnapshot(ctx: PageContext): HTMLElement {
  snapshotValueNodes.clear();
  snapshotHealthNode = null;
  const state = dashboardSnapshotState(ctx);
  snapshotHealthNode = el('span', { class: `chip dashboard-snapshot-health status-${state.health}`, text: state.healthLabel });
  const labels: Array<{ id: DashboardSnapshotId; label: string }> = [
    { id: 'gpu', label: 'GPU' },
    { id: 'driver', label: 'Driver' },
    { id: 'tuning', label: 'Tuning' },
    { id: 'rebar', label: 'ReBAR' },
    { id: 'vram', label: 'VRAM' },
    { id: 'capture', label: 'Arc Capture' },
  ];
  const items = labels.map(({ id, label }) => {
    const item = state.values[id];
    const valueNode = el('strong', { class: 'dashboard-snapshot-value', text: item.value, dataset: { snapshotValue: id } });
    snapshotValueNodes.set(id, valueNode);
    return el('div', { class: 'dashboard-snapshot-item' }, [
      el('span', { class: 'dashboard-snapshot-label', text: label }),
      valueNode,
      el('span', { class: 'dashboard-snapshot-note', text: item.note }),
    ]);
  });
  return el('section', { class: 'card dashboard-snapshot-card' }, [
    el('div', { class: 'dashboard-snapshot-heading' }, [
      el('div', {}, [
        el('span', { class: 'dashboard-eyebrow', text: 'System status' }),
        el('h2', { class: 'card-title', text: 'System snapshot' }),
      ]),
      snapshotHealthNode,
    ]),
    el('div', { class: 'dashboard-snapshot-grid' }, items),
    el('div', { class: 'dashboard-snapshot-actions' }, [
      dashboardAction('Open Arc Capture', '#/recording'),
      dashboardAction('Open Monitoring', '#/monitoring'),
    ]),
  ]);
}

function updateDashboardSnapshot(ctx: PageContext): void {
  const state = dashboardSnapshotState(ctx);
  for (const [id, node] of snapshotValueNodes) node.textContent = state.values[id].value;
  if (snapshotHealthNode) {
    snapshotHealthNode.className = `chip dashboard-snapshot-health status-${state.health}`;
    snapshotHealthNode.textContent = state.healthLabel;
  }
}

export const dashboardPage: Page = {
  id: 'dashboard',

  render(container: HTMLElement, ctx: PageContext) {
    lastSig = currentSig(ctx);
    const s = ctx.store.get();
    const device = s.devices.find((d) => d.id === s.deviceId) ?? null;
    const osOnly = device?.synthetic === true && device.backendKind === 'os';
    const noIntelPresentation = s.noIntel || osOnly;
    // M30: static GPU rows are sourced only from the selected inventory row.
    // The explicit no-device presentation uses the already-selected OS GPU
    // object; no name match may attach another controller's facts here.
    const selectedController = selectedDashboardController(device?.osController, s.osGpu, s.deviceId !== null);
    const matchedController = selectedController;
    const osController = selectedController;
    const rebarController = selectedController
      ? { ...selectedController, rebarActive: selectedController.rebarActive ?? null }
      : null;
    // M17d: the no-Intel Board-partner decode - the controller's PNPDeviceID
    // SUBSYS through pure/aib.ts (works for ANY GPU); null -> the honest '-'.
    const osAib = aibOfPnpDeviceId(osController?.pnpDeviceId);
    const rebar = rebarState(rebarController);
    const osRebar = rebarState(rebarController);
    const sysRows = cpuCardRows(s.sysinfo);
    const cpuName = s.sysinfo?.cpu?.name ?? '';
    const gpuName = noIntelPresentation ? (s.osGpu?.name ?? '') : (device?.name ?? '');
    const gpuIcon = gpuIconPath(gpuIconKeyOf(gpuName, device?.gpuVendor));

    clear(container);
    container.append(
      el('h1', { class: 'page-title', text: 'Dashboard' }),

      el('div', { class: 'dashboard-quick-actions' }, [
        el('span', { class: 'dashboard-quick-label', text: 'Quick actions' }),
        dashboardAction('Open Recording', '#/recording'),
        dashboardAction('Manage Profiles', '#/profiles'),
        dashboardAction('Tune GPU', '#/tuning'),
        dashboardAction('Open Monitoring', '#/monitoring'),
      ]),

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

        // --- device card ---
        // M4-F: the card header row carries the compact GPU selector (hidden
        // with <= 1 device - the honest single-device degradation).
        // M4-H (C1): the card title is "GPU" and the device name moved to a
        // kv row under it (the CPU card's layout mirrored: title, then the
        // 'CPU' kv row - the GPU card is title 'GPU' + a 'GPU' kv row). The
        // Driver version row is REMOVED from this card (the health card
        // keeps it - N7: the no-Intel branch gets the SAME restructure).
        // ReBAR pill, Compute, Clocks rows stay.
        el('section', { class: 'card device-card' }, [
          el('div', { class: 'device-card-head' }, [
            el('div', { class: 'hardware-card-heading' }, [
              el('h2', { class: 'card-title', text: 'GPU' }),
              hardwareIcon(gpuIcon, `${gpuName || 'GPU'} icon`, 'gpu'),
            ]),
            buildDeviceSelect(ctx.store, (id) => void selectDevice(id)),
          ]),
          ...(noIntelPresentation
            ? [
                // M4-I (D3)/M17d: the no-Intel branch renders the REAL rows
                // the OS + the vendor lane have: Driver version (the NEW
                // videoControllers driverVersion field - works on any GPU),
                // PNPDeviceID SUBSYS decode through pure/aib.ts
                // aibOfPnpDeviceId - works for ANY GPU; '<vendor>
                // (<model-stripped>)'; unknown -> the honest grey '-'),
                // Compute '<n> Cores' (deviceInfo().computeCores - the NVML
                // core count; honest '-' when the lane has no source),
                // Clocks LIVE (the vendor lane's memClockMhz + gpuClockMhz
                // replace the static '- MHz Core / - MHz Memory' on ticks),
                // VRAM (deviceInfo().vramBytes - the NVML total primary -
                // with the OS controller bytes as the fallback), ReBAR pill
                // REAL (the OS pnputil/allocated sources are GPU-agnostic).
                // The 'Non supported GPU' note stays. NOTE: this REVERSES
                // the M4-H pin that asserted the driver row's ABSENCE AND
                // the M17c round-1-N3 pin that asserted the Board-partner
                // row's ABSENCE on the no-Intel branch - the inversions are
                // explicit (the M17d no-Intel rows are real, not placeholders).
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
                  el('div', { class: 'kv', 'data-label': 'Clocks' }, [el('span', { class: 'kv-clocks', text: noIntelClocksText(s.latestSample) })]),
                  el('div', { class: 'kv', 'data-label': 'VRAM' }, [el('span', { text: vramRowValue(s.vendorInfo?.vramBytes ?? s.osGpu?.vramBytes, null) })]),
                  ...(sharedMemoryBytesOf(null, s.osGpu) !== null
                    ? [el('div', { class: 'kv', 'data-label': 'Shared GPU Memory' }, [el('span', { text: `${formatGpuMemoryGb(sharedMemoryBytesOf(null, s.osGpu))} GB` })])]
                    : []),
                  el('div', { class: 'kv kv-rebar' }, [
                    el('span', { class: `chip rebar-pill status-${osRebar.level}`, text: osRebar.label }),
                  ]),
                ]),
                el('p', { class: 'card-note', text: 'Non supported GPU - overclocking requires an Intel Arc GPU; this state is permanent on non-Intel machines.' }),
              ]
            : device
              ? [el('div', { class: 'card-body kv-grid' }, [
                el('div', { class: 'kv', 'data-label': 'GPU' }, [el('span', { text: device.name })]),
                // M17c: the Board partner row BELOW the Device row -
                // '<AIB vendor> (<model>)' from the caps AIB fields
                // (aibVendor/aibModel - the pure/aib.ts decode); unknown
                // (both null) -> the honest grey '-' (text-unknown).
                // M17d: the no-Intel branch has its OWN Board-partner row
                // (the PNP SUBSYS decode - the round-1-N3 absence note is
                // INVERTED; see the no-Intel branch below).
                el('div', { class: 'kv', 'data-label': 'Board partner' }, [
                  el('span', {
                    class: s.caps?.aibVendor ? undefined : 'text-unknown',
                    text: boardPartnerText(s.caps),
                  }),
                ]),
                // M2b-B: no PCI ID, no persistent waiver status.
                device.numXeCores > 0
                  ? el('div', { class: 'kv', 'data-label': 'Compute' }, [el('span', { text: `Xe Cores ${device.numXeCores} - Shader Units ${shaderUnits(device.numXeCores)}` })])
                  : null,
                // M4-D: core + memory clock BUNDLED into one row -
                // "2400 MHz Core / 2187 MHz Memory" (the memory half tracks
                // the latest telemetry sample in place).
                el('div', { class: 'kv', 'data-label': 'Clocks' }, [el('span', {
                  class: 'kv-clocks',
                  text: `${device.graphicsClockMHz} MHz Core / ${s.latestSample?.memClockMhz !== undefined ? s.latestSample.memClockMhz : '--'} MHz Memory`,
                })]),
                // M4-I (B2): the VRAM row below the Shader info - the same
                // ceil contract as formatDeviceName with the memType CARRIED
                // ON THE DEVICE PAYLOAD (no renderer-side table).
                el('div', { class: 'kv', 'data-label': 'VRAM' }, [el('span', { text: vramRowValue(device.vramBytes, device.memType) })]),
                ...(sharedMemoryBytesOf(device, null) !== null
                  ? [el('div', { class: 'kv', 'data-label': 'Shared GPU Memory' }, [el('span', { text: `${formatGpuMemoryGb(sharedMemoryBytesOf(device, null))} GB` })])]
                  : []),
                // M4-D2 (§3): the ReBAR pill is STANDALONE - no label kv row
                // around it (the "Resizable BAR" row is gone). Green "ReBAR
                // on" / red "ReBAR off" / grey "ReBAR -", data-driven from
                // the sysinfo controller's rebarActive.
                el('div', { class: 'kv kv-rebar' }, [
                  el('span', { class: `chip rebar-pill status-${rebar.level}`, text: rebar.label }),
                ]),
              ])]
            : [el('div', { class: 'card-body', text: s.bootError ?? 'Searching for a graphics device…' })]),
        ]),

        // --- M3-A: the general GPU Status card (was the Service Status card) ---
        healthCard(ctx),
      ]),

      // Performance Pulse above owns live telemetry; this card keeps the
      // bottom of the dashboard useful for system context and actions.
      dashboardSnapshot(ctx),
    );
  },

  onUpdate(container: HTMLElement, ctx: PageContext) {
    // Full re-render only when a status slot changed (boot probe, boot
    // errors) - NOT on telemetry ticks. A tick refreshes the live cards and
    // snapshot values in place; the clocks health row is gone.
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
    const clocksValue = container.querySelector<HTMLElement>('.card-grid .kv[data-label="Clocks"] span');
    if (clocksValue) {
      const live = ctx.store.get();
      const mem = live.latestSample?.memClockMhz;
      const liveDevice = live.devices.find((d) => d.id === live.deviceId) ?? null;
      const osOnly = liveDevice?.synthetic === true && liveDevice.backendKind === 'os';
      if (live.noIntel || osOnly) {
        const core = live.latestSample?.gpuClockMhz;
        const coreText = typeof core === 'number' && Number.isFinite(core) ? core : '-';
        const memText = typeof mem === 'number' && Number.isFinite(mem) ? mem : '-';
        clocksValue.textContent = `${coreText} MHz Core / ${memText} MHz Memory`;
      } else {
        const core = liveDevice?.graphicsClockMHz;
        clocksValue.textContent = `${core !== undefined ? core : '--'} MHz Core / ${mem !== undefined ? mem : '--'} MHz Memory`;
      }
    }
    // M4-D2 (§6): the CPU card's "Cores / clock" LIVE half (the current
    // frequency, GHz always) tracks the telemetry tick in place - same
    // pattern as the GPU clocks row.
    const liveFreq = container.querySelector<HTMLElement>('.sysinfo-card .kv-live-freq');
    if (liveFreq) liveFreq.textContent = liveFreqText(ctx.store.get().latestSample);
    updateDashboardPulse(ctx);
    updateDashboardSnapshot(ctx);
  },
};
