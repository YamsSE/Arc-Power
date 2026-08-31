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
import { selectDevice } from '../app.ts';
import { shaderUnits } from '../pure/driver.ts';
import { cpuCardRows, rebarState, vramRowValue } from '../pure/sysinfo.ts';
import { formatGpuMemoryGb } from '../pure/gpu-memory.ts';
import { cpuIconKeyOf, cpuIconPath, gpuIconKeyOf, gpuIconPath } from '../pure/hardware-icons.ts';
import { selectedDashboardController } from '../pure/dashboard.ts';
import { aibOfPnpDeviceId } from '../pure/aib.ts';
import { api } from '../ipc.ts';
import type { ProfilesEnvelope, RecordingClip, RecordingStorageInfo, TelemetrySample } from '../types.ts';

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
type DashboardControlId = 'profile' | 'apply' | 'capture' | 'last' | 'storage' | 'attention';
type DashboardControlDatum = { value: string; note: string; level?: 'ok' | 'warn' | 'error' | 'unknown' };
const controlValueNodes = new Map<DashboardControlId, HTMLElement>();
const controlNoteNodes = new Map<DashboardControlId, HTMLElement>();
let controlHealthNode: HTMLElement | null = null;
let controlCenterContext: PageContext | null = null;
let controlCenterLoadPromise: Promise<void> | null = null;
let controlCenterRefreshTimer: ReturnType<typeof setInterval> | null = null;
let controlCenterGeneration = 0;
let controlCenterRemote: {
  profiles: ProfilesEnvelope | null;
  clips: RecordingClip[] | null;
  storage: RecordingStorageInfo | null;
} = { profiles: null, clips: null, storage: null };

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
        el('span', { class: 'dashboard-pulse-inline-value' }, [valueNode, el('span', { class: 'dashboard-pulse-unit', text: metric.unit })]),
      ]),
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
    if (status.activeModes?.video === true && status.activeModes?.replay === true) {
      return { value: 'Recording + replay', note: 'Both capture modes are active' };
    }
    return status.mode === 'replay'
      ? { value: 'Replay buffer', note: 'Capturing the rolling clip window' }
      : { value: 'Recording', note: 'Arc Capture is active' };
  }
  if (status.available) return { value: 'Ready', note: 'Ready when you are' };
  return { value: 'Unavailable', note: 'Capture engine is unavailable' };
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

function dashboardControlCenterState(ctx: PageContext): { health: 'ok' | 'warn' | 'error' | 'unknown'; healthLabel: string; values: Record<DashboardControlId, DashboardControlDatum> } {
  const s = ctx.store.get();
  const device = s.devices.find((entry) => entry.id === s.deviceId) ?? null;
  const osOnly = device?.synthetic === true && device.backendKind === 'os';
  const rows = dashboardHealthRows(ctx, device, osOnly);
  const issue = rows.find((row) => row.level === 'error') ?? rows.find((row) => row.level === 'warn');
  const health = issue?.level ?? (rows.length > 0 ? 'ok' : 'unknown');
  const healthLabel = health === 'ok' ? 'All clear' : health === 'warn' ? 'Check status' : health === 'error' ? 'Needs attention' : 'Waiting';
  const activeProfileId = controlCenterRemote.profiles?.settings.activeProfileId ?? null;
  const activeProfile = controlCenterRemote.profiles?.profiles.find((profile) => profile.id === activeProfileId) ?? null;
  const apply = s.lastApply;
  const capture = snapshotCaptureState(s.recordingStatus);
  const latestClip = newestRecordingClip(controlCenterRemote.clips);
  const storage = controlCenterRemote.storage;
  return {
    health,
    healthLabel,
    values: {
      profile: {
        value: activeProfile?.name ?? (controlCenterRemote.profiles ? 'No active profile' : 'Loading…'),
        note: activeProfile ? (controlCenterRemote.profiles?.settings.ocOnBoot ? 'Starts with Windows' : 'Manual apply') : 'Profiles are optional',
      },
      apply: apply
        ? { value: apply.ok ? 'Applied' : 'Failed', note: compactDashboardText(apply.detail, 'Latest tuning result'), level: apply.ok ? 'ok' : 'error' }
        : { value: 'No apply yet', note: 'Tuning results appear here' },
      capture: { ...capture, level: s.recordingStatus?.running ? 'ok' : s.recordingStatus?.available ? 'ok' : 'unknown' },
      last: latestClip
        ? { value: compactDashboardText(latestClip.fileName, 'Latest capture'), note: 'Latest saved clip or recording' }
        : { value: controlCenterRemote.clips ? 'No captures yet' : 'Loading…', note: 'Saved clips and recordings' },
      storage: storage
        ? { value: dashboardStorageText(storage.freeBytes), note: compactDashboardText(storage.location, 'Recording folder') }
        : { value: 'Loading…', note: 'Recording folder space' },
      attention: issue
        ? { value: issue.level === 'error' ? 'Needs attention' : `Check ${issue.label}`, note: compactDashboardText(issue.detail, 'Review this status'), level: issue.level }
        : { value: health === 'unknown' ? 'Waiting' : 'All clear', note: health === 'unknown' ? 'Status is still loading' : 'No action needed', level: health },
    },
  };
}

function dashboardControlCenter(ctx: PageContext): HTMLElement {
  controlCenterContext = ctx;
  controlValueNodes.clear();
  controlNoteNodes.clear();
  controlHealthNode = null;
  const state = dashboardControlCenterState(ctx);
  controlHealthNode = el('span', { class: `chip dashboard-control-health status-${state.health}`, text: state.healthLabel });
  const labels: Array<{ id: DashboardControlId; label: string }> = [
    { id: 'profile', label: 'Active profile' },
    { id: 'apply', label: 'Last apply' },
    { id: 'capture', label: 'Arc Capture' },
    { id: 'last', label: 'Last capture' },
    { id: 'storage', label: 'Storage' },
    { id: 'attention', label: 'Attention' },
  ];
  const items = labels.map(({ id, label }) => {
    const item = state.values[id];
    const valueNode = el('strong', { class: 'dashboard-control-value', text: item.value, dataset: { controlValue: id } });
    const noteNode = el('span', { class: 'dashboard-control-note', text: item.note, dataset: { controlNote: id } });
    controlValueNodes.set(id, valueNode);
    controlNoteNodes.set(id, noteNode);
    return el('div', { class: `dashboard-control-item${item.level ? ` status-${item.level}` : ''}` }, [
      el('span', { class: 'dashboard-control-label', text: label }),
      valueNode,
      noteNode,
    ]);
  });
  return el('section', { class: 'card dashboard-control-card' }, [
    el('div', { class: 'dashboard-control-heading' }, [
      el('div', {}, [
        el('span', { class: 'dashboard-eyebrow', text: 'Activity & actions' }),
        el('h2', { class: 'card-title', text: 'Control center' }),
      ]),
      controlHealthNode,
    ]),
    el('div', { class: 'dashboard-control-grid' }, items),
    el('div', { class: 'dashboard-control-actions' }, [
      dashboardAction('Open Recording', '#/recording'),
      dashboardAction('Open Profiles', '#/profiles'),
      dashboardAction('Open Tuning', '#/tuning'),
    ]),
  ]);
}

function updateDashboardControlCenter(ctx: PageContext): void {
  const state = dashboardControlCenterState(ctx);
  for (const [id, node] of controlValueNodes) node.textContent = state.values[id].value;
  for (const [id, node] of controlNoteNodes) node.textContent = state.values[id].note;
  if (controlHealthNode) {
    controlHealthNode.className = `chip dashboard-control-health status-${state.health}`;
    controlHealthNode.textContent = state.healthLabel;
  }
}

async function loadDashboardControlCenter(ctx: PageContext, force = false): Promise<void> {
  controlCenterContext = ctx;
  if (controlCenterLoadPromise && !force) return controlCenterLoadPromise;
  const generation = ++controlCenterGeneration;
  const request = Promise.all([
    api.profilesList().catch(() => null),
    api.recordingClipsList().catch(() => null),
    api.recordingStorageInfo().catch(() => null),
  ]).then(([profiles, clips, storage]) => {
    if (generation !== controlCenterGeneration) return;
    controlCenterRemote = { profiles, clips, storage };
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

      // Performance Pulse above owns live telemetry; the Control Center
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
    // Control Center values in place; the clocks health row is gone.
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
  controlHealthNode = null;
}
