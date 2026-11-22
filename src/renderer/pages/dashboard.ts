// Arc Power - Dashboard: live GPU telemetry, GPU artwork, CPU and memory
// details, and a compact GPU information panel with the installed driver
// version and ReBAR status.
//
// The page re-renders fully only when a status slot changes (boot probe,
// boot errors); telemetry ticks refresh the live cards in place - no
// per-tick DOM churn (the decision lives in pure/status.ts::
// dashboardNeedsFullRender, unit-tested).

import { el, clear, svgEl } from '../dom.ts';
import type { AppState, Page, PageContext } from '../router.ts';
import { dashboardNeedsFullRender } from '../pure/status.ts';
import type { DashboardSig } from '../pure/status.ts';
import { buildDeviceSelect } from '../components/device-select.ts';
import { decodeDriverVersion, shaderUnits } from '../pure/driver.ts';
import { cpuCardRows, ghzFreqText, rebarState, vramRowValue } from '../pure/sysinfo.ts';
import { formatGpuMemoryGb } from '../pure/gpu-memory.ts';
import { cpuIconKeyOf, cpuIconPath, gpuIconKeyOf, gpuIconPath } from '../pure/hardware-icons.ts';
import { deviceHardwareKey } from '../pure/device.ts';
import { dashboardGpuOrder, gpuSectionLabel } from '../pure/dashboard.ts';
import { amdComputeUnitsForDashboardDevice } from '../pure/dashboard-vendor-info.ts';
import { dashboardGpuDisplayName, dashboardRetailAssetPath } from '../pure/dashboard-retail-assets.ts';
import { gpuDisplayName } from '../pure/gpu-display-name.ts';
import { createIntelDriverCheckLoader, intelDriverKind, newerIntelRelease, type IntelDriverKind, type IntelDriverUpdateCheck } from '../pure/intel-driver-updates.ts';
import { confirmIntelDriverInstall, showIntelDriverUpdateDialog } from '../components/intel-driver-update-dialog.ts';
import { aibOf, aibOfPnpDeviceId } from '../pure/aib.ts';
import { api } from '../ipc.ts';
import { toast } from '../components/toast.ts';
import type { TelemetrySample } from '../types.ts';
import { TELEMETRY_HISTORY_POINTS, TELEMETRY_PULSE_COLORS } from '../pure/telemetry-visuals.ts';
import { dashboardSparklinePaths, nearestDashboardTelemetryPoint } from '../pure/dashboard-telemetry-graph.ts';

/** M4-D2 (§6): the "Cores / clock" bundled row's LIVE half - the current
 *  CPU frequency from the telemetry tick, ALWAYS in GHz with 1 decimal
 *  (" @ 4.3 GHz" joins the static cores/threads
 *  half); a null/non-finite/<= 0 sample -> honest '-' (never a fake number,
 *  matching the Monitoring tile's ghzFreq contract). */
function liveFreqRowText(sample: TelemetrySample | null): string {
  const text = ghzFreqText(sample?.cpuFreqMhz);
  return text === '-' ? ' @ - GHz' : ` @ ${text}`;
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

const DASHBOARD_HISTORY_LIMIT = TELEMETRY_HISTORY_POINTS;
const intelDriverNoticeNodes = new Map<string, { row: HTMLElement; content: HTMLElement; kind: IntelDriverKind; installed: string; release?: import('../pure/intel-driver-updates.ts').IntelDriverRelease; downloaded: boolean; confirming: boolean; installing: boolean }>();
const loadIntelDriverCheck = createIntelDriverCheckLoader(() => api.intelDriverUpdateCheck());
type IntelDownloadStatus = { downloaded: boolean; sizeBytes: number | null };
type IntelDashboardApi = {
  intelDriverDownloadStatus(kind: IntelDriverKind, version: string): Promise<IntelDownloadStatus>;
  intelDriverInstall(kind: IntelDriverKind, version: string): Promise<{ launched: true }>;
};
const intelDashboardApi = api as typeof api & IntelDashboardApi;

export function intelDriverNoticeAction(downloaded: boolean): string {
  return downloaded ? 'Install new Driver now' : 'New Driver Version Available';
}

export async function confirmIntelDriverInstallTransition(
  entry: { downloaded: boolean; confirming: boolean; installing: boolean },
  isCurrent: () => boolean,
  confirm: () => Promise<boolean>,
  install: () => void,
  render: () => void,
): Promise<boolean> {
  if (!entry.downloaded || entry.confirming || entry.installing) return false;
  entry.confirming = true;
  render();
  const confirmed = await confirm();
  entry.confirming = false;
  if (!confirmed || !isCurrent()) {
    render();
    return false;
  }
  entry.installing = true;
  render();
  install();
  return true;
}

function renderIntelDriverAction(key: string): void {
  const entry = intelDriverNoticeNodes.get(key);
  const release = entry?.release;
  if (!entry || !release || !entry.row.isConnected) return;
  const action = intelDriverNoticeAction(entry.downloaded);
  entry.content.replaceChildren(el('span', { class: 'intel-driver-update-notice' }, [
    el('span', { class: 'intel-driver-update-versions', text: `${entry.installed} → ${release.version}` }),
    el('button', {
      class: 'btn intel-driver-update-button', type: 'button', text: action,
      'aria-label': `${action}; Intel driver version ${release.version}`,
      disabled: entry.confirming || entry.installing,
      onClick: async () => {
        if (!entry.downloaded) {
          showIntelDriverUpdateDialog(entry.kind, entry.installed, release, false, () => {
            for (const [noticeKey, notice] of intelDriverNoticeNodes) {
              if (notice.kind !== entry.kind || notice.release?.version !== release.version) continue;
              notice.downloaded = true;
              renderIntelDriverAction(noticeKey);
            }
          });
          return;
        }
        await confirmIntelDriverInstallTransition(
          entry,
          () => intelDriverNoticeNodes.get(key) === entry && entry.row.isConnected && entry.release === release,
          confirmIntelDriverInstall,
          () => {
            void intelDashboardApi.intelDriverInstall(entry.kind, release.version).then(() => {
              entry.installing = false;
              renderIntelDriverAction(key);
            }).catch(() => {
              entry.installing = false;
              void intelDashboardApi.intelDriverDownloadStatus(entry.kind, release.version).then((status) => {
                if (intelDriverNoticeNodes.get(key) !== entry || entry.release !== release || !entry.row.isConnected) return;
                entry.downloaded = status.downloaded;
                renderIntelDriverAction(key);
              }).catch(() => undefined);
              toast('error', 'Intel driver installer failed', 'Could not launch the interactive installer. Your PC has not been changed. Please try again.');
              renderIntelDriverAction(key);
            });
          },
          () => renderIntelDriverAction(key),
        );
      },
    }),
  ]));
}

function renderIntelDriverNotice(key: string, check: IntelDriverUpdateCheck): void {
  const entry = intelDriverNoticeNodes.get(key);
  if (!entry || !entry.row.isConnected) return;
  const release = newerIntelRelease(entry.kind, entry.installed, check);
  if (!release) return;
  entry.release = release;
  entry.row.hidden = false;
  renderIntelDriverAction(key);
  void intelDashboardApi.intelDriverDownloadStatus(entry.kind, release.version).then((status) => {
    if (intelDriverNoticeNodes.get(key) !== entry || entry.release !== release || !entry.row.isConnected) return;
    // A slower startup status response must not overwrite a download that
    // completed after this check began.
    entry.downloaded = entry.downloaded || status.downloaded;
    renderIntelDriverAction(key);
  }).catch(() => undefined);
}
type DashboardPulseLane = {
  key: string;
  vramCapacityGiB: number | null;
  history: TelemetrySample[];
  valueNodes: Map<DashboardPulseId, HTMLElement>;
  pathNodes: Map<DashboardPulseId, SVGPathElement>;
  areaPathNodes: Map<DashboardPulseId, SVGPathElement>;
  hoverNodes: Map<DashboardPulseId, { surface: HTMLElement; crosshair: HTMLElement; tooltip: HTMLElement }>;
  rangeMinNodes: Map<DashboardPulseId, HTMLElement>;
  rangeMaxNodes: Map<DashboardPulseId, HTMLElement>;
};
const dashboardPulseLanes = new Map<string, DashboardPulseLane>();
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
    valueNodes: new Map(),
    pathNodes: new Map(),
    areaPathNodes: new Map(),
    hoverNodes: new Map(),
    rangeMinNodes: new Map(),
    rangeMaxNodes: new Map(),
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

function pulseRangeValue(id: DashboardPulseId, value: number): string {
  if (id === 'vram') return Number.isInteger(value) ? String(value) : value.toFixed(1);
  return String(Math.round(value));
}

function pulseHoverValue(id: DashboardPulseId, value: number): string {
  return id === 'power' || id === 'vram' ? value.toFixed(1) : String(Math.round(value));
}

function pulseGraphPoints(lane: DashboardPulseLane, id: DashboardPulseId): Array<{ t: number; value: number | undefined }> {
  return lane.history
    .map((sample) => ({ t: sample.t, value: pulseSampleValue(id, sample) }))
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
  const points = pulseGraphPoints(lane, id);
  const graphRange = pulseGraphRange(lane, id);
  const minNode = lane.rangeMinNodes.get(id);
  const maxNode = lane.rangeMaxNodes.get(id);
  if (minNode) minNode.textContent = pulseRangeValue(id, graphRange.min);
  if (maxNode) maxNode.textContent = pulseRangeValue(id, graphRange.max);
  const paths = dashboardSparklinePaths(points, graphRange.min, graphRange.max);
  path.setAttribute('d', paths.line);
  if (area) area.setAttribute('d', paths.area);
}

function updatePulseLane(lane: DashboardPulseLane, sample: TelemetrySample | null): void {
  rememberDashboardSample(lane, sample);
  for (const metric of DASHBOARD_PULSE) {
    const valueNode = lane.valueNodes.get(metric.id);
    if (valueNode) valueNode.textContent = pulseDisplayValue(metric.id, sample);
    if (!nearestDashboardTelemetryPoint(pulseGraphPoints(lane, metric.id), 0.5)) {
      const hover = lane.hoverNodes.get(metric.id);
      if (hover) {
        hover.crosshair.hidden = true;
        hover.tooltip.hidden = true;
      }
    }
    updatePulsePath(lane, metric.id);
  }
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
  gpuCaption: string,
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
      if (lane.history.length === 0) {
        crosshair.hidden = true;
        tooltip.hidden = true;
        return;
      }
      if (rect.width <= 0) return;
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const point = nearestDashboardTelemetryPoint(points, ratio);
      if (!point) {
        crosshair.hidden = true;
        tooltip.hidden = true;
        return;
      }
      crosshair.style.left = `${ratio * 100}%`;
      crosshair.hidden = false;
      tooltip.textContent = `${pulseHoverValue(metric.id, point.value!)} ${metric.unit}`;
      tooltip.style.left = `${ratio * 100}%`;
      // Keep the readout on the same side as the cursor until it crosses the
      // graph midpoint, then flip it left so the value remains beside the
      // hovered point instead of lagging behind it.
      tooltip.style.transform = ratio >= .5 ? 'translateX(-100%)' : 'none';
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
  const retailArt = dashboardRetailArt(retailVariant, `${gpuLabel} ${retailVariant} GPU artwork`);
  const retailAsset = gpuRetailAsset
    ? el('img', {
        class: 'dashboard-retail-art-asset',
        src: gpuRetailAsset,
        alt: `${gpuLabel} GPU retail artwork`,
        loading: 'eager',
        decoding: 'async',
      }) as HTMLImageElement
    : null;
  if (retailAsset) {
    retailAsset.addEventListener('load', () => { retailArt.setAttribute('hidden', ''); }, { once: true });
    retailAsset.addEventListener('error', () => {
      retailAsset.remove();
      retailArt.removeAttribute('hidden');
    }, { once: true });
  }
  const retailArtSlot = el('div', { class: 'dashboard-retail-art-slot' }, [retailAsset, retailArt]);
  // The normalized device name is the visual column's header: it sits above the
  // artwork so the lane is identifiable even when the art is generic.
  const gpuNameCaption = el('span', { class: 'dashboard-pulse-gpu-name', text: gpuCaption, title: gpuCaption });
  const visualColumn = el('div', { class: 'dashboard-pulse-visual' }, [gpuNameCaption, retailArtSlot]);
  updatePulseLane(lane, sample);
  return el('section', { class: 'dashboard-pulse-lane', dataset: { deviceKey: lane.key } }, [
    el('div', { class: 'dashboard-pulse-hud' }, [
      visualColumn,
      el('div', { class: 'dashboard-pulse-grid' }, pulseCards),
    ]),
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
        name: dashboardGpuDisplayName(activeDevice),
        key: dashboardDeviceKey(activeDevice),
        sample: dashboardSampleFor(state, activeDevice),
        vramCapacityBytes: dashboardVramCapacityBytes(
          activeDevice,
          activeDevice.integrated === true || activeDevice.mobile === true ? state.sysinfo?.ram.totalBytes ?? null : null,
        ),
        caption: gpuDisplayName({
          name: activeDevice.name,
          vendor: activeDevice.gpuVendor,
          // A discrete card's own VRAM only: an iGPU's shared system-memory
          // ceiling is not a GPU capacity and must not be printed as one.
          vramGb: activeDevice.integrated === true || typeof activeDevice.vramBytes !== 'number'
            ? null
            : activeDevice.vramBytes / (1024 ** 3),
        }),
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
        caption: gpuDisplayName({
          name: state.osGpu?.name ?? null,
          vendor: null,
          vramGb: typeof state.osGpu?.vramBytes === 'number' ? state.osGpu.vramBytes / (1024 ** 3) : null,
        }),
      }];
  const activeKeys = new Set(entries.map((entry) => entry.key));
  for (const key of dashboardPulseLanes.keys()) {
    if (!activeKeys.has(key)) dashboardPulseLanes.delete(key);
  }
  return el('section', { class: 'card dashboard-pulse-card', dataset: { gpuCount: String(devices.length) } }, [
    el('div', { class: 'dashboard-pulse-heading' }, [
      el('div', { class: 'dashboard-pulse-heading-copy' }, [
        el('h2', { class: 'card-title', text: 'Live Monitoring' }),
      ]),
      el('span', { class: `dashboard-pulse-device${entries.length ? '' : ' text-unknown' }`, text: `${entries.length} GPU${entries.length === 1 ? '' : 's'}` }),
    ]),
    el('div', { class: 'dashboard-pulse-lanes' }, entries.map((entry) => pulseLaneElement(
      pulseLaneFor(entry.key), entry.label, entry.name, entry.caption,
      entry.device ? (() => {
        const aib = aibOf(entry.device.pciSubsysVendorId, entry.device.pciSubsysId);
        return dashboardRetailAssetPath({
          name: entry.device.name,
          gpuVendor: entry.device.gpuVendor,
          pciDeviceId: entry.device.pciDeviceId,
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

function dashboardGpuCard(device: AppState['devices'][number], index: number, total: number, state: AppState, visible = true): HTMLElement {
  const displayName = dashboardGpuDisplayName(device);
  const sample = dashboardSampleFor(state, device);
  const rebar = rebarState(device.osController ? { rebarActive: device.osController.rebarActive } : null);
  const aib = aibOf(device.pciSubsysVendorId, device.pciSubsysId)
    ?? aibOfPnpDeviceId(device.osController?.pnpDeviceId);
  const isAmd = device.gpuVendor === 'amd'
    || /VEN_1002/i.test(String(device.osController?.pnpDeviceId ?? ''))
    || /\b(?:amd|radeon)\b/i.test(device.name);
  const amdUnits = amdComputeUnitsForDashboardDevice(device, state.deviceId, state.vendorInfo);
  const amdCompute = amdUnits !== null ? `${amdUnits} Compute Units` : null;
  const core = Number.isFinite(device.graphicsClockMHz) ? device.graphicsClockMHz : null;
  const memory = typeof sample?.memClockMhz === 'number' && Number.isFinite(sample.memClockMhz)
    ? sample.memClockMhz
    : null;
  const intelKind = intelDriverKind(device.gpuVendor, device.name, device.pciVendorId);
  const installedDriver = decodeDriverVersion(device.osController?.driverVersion ?? device.driverVersion);
  const driverRow = intelKind
    ? el('div', { class: 'kv intel-driver-version-row', 'data-label': 'Installed Driver Version' }, [
        el('span', { class: 'intel-driver-version-value' }, [
          el('span', { class: 'intel-driver-update-content', 'aria-live': 'polite', text: installedDriver ?? '-' }),
          el('button', { class: 'driver-library-launch', type: 'button', title: 'Intel Driver Library', 'aria-label': 'Intel Driver Library', onClick: () => { window.location.hash = `#/driver-library?deviceId=${encodeURIComponent(String(device.id))}`; } }, [
            el('span', { class: 'sidebar-icon sidebar-icon-driver-library', 'aria-hidden': 'true' }),
          ]),
        ]),
      ])
    : null;
  if (driverRow && intelKind && installedDriver) {
    const key = dashboardDeviceKey(device);
    const entry = {
      row: driverRow,
      content: driverRow.querySelector('.intel-driver-update-content') as HTMLElement,
      kind: intelKind,
      installed: installedDriver,
      downloaded: false,
      confirming: false,
      installing: false,
    };
    intelDriverNoticeNodes.set(key, entry);
    void loadIntelDriverCheck().then((check) => {
      if (check && intelDriverNoticeNodes.get(key) === entry) renderIntelDriverNotice(key, check);
    });
  }
  return el('section', { class: 'card device-card', hidden: !visible, dataset: { deviceKey: dashboardDeviceKey(device), deviceId: String(device.id) } }, [
    el('div', { class: 'device-card-head' }, [
      el('div', { class: 'hardware-card-heading' }, [
        el('h2', { class: 'card-title', text: gpuSectionLabel(index, total) }),
        hardwareIcon(gpuIconPath(gpuIconKeyOf(device.name, device.gpuVendor, device)), `${displayName} icon`, 'gpu'),
      ]),
    ]),
    el('div', { class: 'card-body kv-grid' }, [
      el('div', { class: 'kv', 'data-label': 'GPU' }, [el('span', { text: displayName })]),
      ...(driverRow ? [driverRow] : []),
      el('div', { class: 'kv', 'data-label': 'Board partner' }, [el('span', {
        class: aib ? undefined : 'text-unknown',
        text: aib ? (aib.model ? `${aib.vendor} (${aib.model})` : aib.vendor) : '-',
      })]),
      el('div', { class: 'kv', 'data-label': 'Compute' }, [el('span', {
        class: (isAmd ? amdCompute !== null : device.numXeCores > 0) ? undefined : 'text-unknown',
        text: isAmd
          ? amdCompute ?? '-'
          : device.numXeCores > 0
            ? `Xe Cores ${device.numXeCores} - Shader Units ${shaderUnits(device.numXeCores)}`
            : '-',
      })]),
      el('div', { class: 'kv', 'data-label': 'Clocks' }, [el('span', {
        class: 'kv-clocks',
        text: `${core ?? '--'} MHz Core / ${memory ?? '--'} MHz Memory`,
      })]),
      el('div', { class: 'kv', 'data-label': 'VRAM' }, [el('span', { class: 'dashboard-vram-value' }, [
        el('span', { text: vramRowValue(device.vramBytes, device.memType) }),
        el('span', { class: 'dashboard-vram-separator', 'aria-hidden': 'true', text: '·' }),
        el('span', { class: `chip rebar-pill rebar-pill-compact status-${rebar.level}`, text: rebar.label }),
      ])]),
      ...(sharedMemoryBytesOf(device, null) !== null
        ? [el('div', { class: 'kv', 'data-label': 'Shared GPU Memory' }, [el('span', { text: `${formatGpuMemoryGb(sharedMemoryBytesOf(device, null))} GB` })])]
        : []),
    ]),
  ]);
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
    const amdGpu = device?.gpuVendor === 'amd'
      || /VEN_1002/i.test(String(osController?.pnpDeviceId ?? s.osGpu?.pnpDeviceId ?? ''))
      || /\b(?:amd|radeon)\b/i.test(gpuName);
    const gpuIcon = gpuIconPath(gpuIconKeyOf(gpuName, device?.gpuVendor, device ?? s.osGpu));
    const deviceSelect = buildDeviceSelect(ctx.store, (id) => void ctx.selectDevice?.(id));

    clear(container);
    intelDriverNoticeNodes.clear();
    container.append(
      el('header', { class: 'dashboard-hud-header' }, [
        el('div', { class: 'dashboard-hud-header-copy' }, [
          el('h1', { class: 'dashboard-hud-title', text: 'Dashboard' }),
        ]),
        el('div', { class: 'dashboard-hud-header-controls' }, [
          ...(deviceSelect ? [
            el('div', { class: 'dashboard-hud-selector' }, [
              el('span', { class: 'dashboard-hud-selector-label', text: 'ACTIVE GPU' }),
              deviceSelect,
            ]),
          ] : []),
        ]),
      ]),

      dashboardPulse(ctx),

      // Keep the dashboard focused on the hardware inventory and the live
      // telemetry graphs. Capture controls live in Recording.
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
                el('span', { class: 'kv-live-freq', text: liveFreqRowText(s.latestSample) }),
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
                  el('div', { class: 'kv', 'data-label': 'Installed Driver Version' }, [el('span', { text: decodeDriverVersion(osController?.driverVersion ?? '') ?? '-' })]),
                  el('div', { class: 'kv', 'data-label': 'Compute' }, [el('span', {
                    class: (amdGpu
                      ? typeof s.vendorInfo?.computeUnits === 'number' && s.vendorInfo.computeUnits > 0
                      : typeof s.vendorInfo?.computeCores === 'number' && s.vendorInfo.computeCores > 0) ? undefined : 'text-unknown',
                    text: amdGpu
                      ? typeof s.vendorInfo?.computeUnits === 'number' && Number.isFinite(s.vendorInfo.computeUnits) && s.vendorInfo.computeUnits > 0
                        ? `${s.vendorInfo.computeUnits} Compute Units`
                        : '-'
                      : typeof s.vendorInfo?.computeCores === 'number' && Number.isFinite(s.vendorInfo.computeCores) && s.vendorInfo.computeCores > 0
                        ? `${s.vendorInfo.computeCores} Cores`
                        : '-',
                  })]),
                  el('div', { class: 'kv', 'data-label': 'Clocks' }, [el('span', { class: 'kv-clocks', text: noIntelClocksText(firstSample) })]),
                  el('div', { class: 'kv', 'data-label': 'VRAM' }, [el('span', { class: 'dashboard-vram-value' }, [
                    el('span', { text: vramRowValue(s.vendorInfo?.vramBytes ?? s.osGpu?.vramBytes, null) }),
                    el('span', { class: 'dashboard-vram-separator', 'aria-hidden': 'true', text: '·' }),
                    el('span', { class: `chip rebar-pill rebar-pill-compact status-${osRebar.level}`, text: osRebar.label }),
                  ])]),
                  ...(sharedMemoryBytesOf(null, s.osGpu) !== null
                    ? [el('div', { class: 'kv', 'data-label': 'Shared GPU Memory' }, [el('span', { text: `${formatGpuMemoryGb(sharedMemoryBytesOf(null, s.osGpu))} GB` })])]
                    : []),
                ]),
                el('p', { class: 'card-note', text: 'Non supported GPU - overclocking requires an Intel Arc GPU; this state is permanent on non-Intel machines.' }),
              ]),
            ]
          : device
            ? [dashboardGpuCard(device, 0, dashboardDevices.length, s, activeDashboardKey === null || dashboardDeviceKey(device) === activeDashboardKey)]
            : [el('section', { class: 'card device-card' }, [el('div', { class: 'card-body', text: s.bootError ?? 'Searching for a graphics device…' })])]),

        ...dashboardDevices.slice(1).map((gpu, index) => dashboardGpuCard(gpu, index + 1, dashboardDevices.length, s, activeDashboardKey === null || dashboardDeviceKey(gpu) === activeDashboardKey)),

      ]),
    );
  },

  onUpdate(container: HTMLElement, ctx: PageContext) {
    // Full re-render only when a status slot changed (boot probe, boot
    // errors) - NOT on telemetry ticks. A tick refreshes the live cards and
    // capture buttons in place.
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
    if (liveFreq) liveFreq.textContent = liveFreqRowText(ctx.store.get().latestSample);
    updateDashboardPulse(ctx);
  },

};
