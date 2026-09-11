// Arc Power - M5 the software overlay renderer (the Overlay window).
//
// Renders the RTSS-style HUD: SIX BOLD monospace lines (FPS / CPU / RAM /
// GPU / VRAM / API - the M12 Memory + VRAM rows joined below the CPU / GPU
// rows; M13: the API row joined between the VRAM row and the frametime
// strip) from the forwarded telemetry stream + the 1 s fps-poll, plus the
// frametime polyline on a transparent canvas (ONLY the 1.5px line - no
// grid, no background). The window itself is transparent/frameless/
// unfocusable and ignores mouse input - the text floats directly over the
// screen/game. M16 (amended 2026-08-11): the GPU voltage renders as a
// FIELD INSIDE the GPU row (between the temp and the power fields) - the
// standalone Voltage row is gone and the line count is back to SIX.
//
// The scale's single source of truth (M7): the 'overlay:settings' push
// carries the SAME persisted overlayScale the main-side geometry used for
// the window resize (the push + the resize are applied together in main) -
// this renderer re-renders against the pushed value, never its own copy.
//
// M6: the SAME push carries the persisted overlayColor + overlayStats. The
// color applies via CSSOM (a --overlay-color CSS var on <html> - CSP-safe:
// style-src 'self' blocks inline style ATTRIBUTES, not stylesheet/CSSOM
// writes; the frametime canvas strokeStyle takes the SAME hex - never the
// old hardcoded white) and the stats drive which fields/lines render (a
// stat off -> its field vanishes; a line fully off -> the div writes '' -
// the fixed divs are never removed). The frametime stat is NOT a line - it
// toggles the canvas strip's visibility.
//
// M6-amd2 (the amendment - the "below the FPS" part retracted, the
// graph stays at the bottom): a frametime VALUE line sits directly BELOW
// the canvas (#overlay-frametime-value) showing the latest derived frame
// time with MAXIMUM 2 decimals ('16.67ms' / '16.7ms' - never padded;
// M18: the unit is GLUED to the number like every other value; honest
// '-' when no data). The frametime stat controls BOTH the strip
// and the number - a stat off hides them together.

import { api } from './ipc.ts';
import { overlayLines, normalizeOverlayStats, deriveFrameTimeMs, formatFrametime, clampOverlayScale, isValidOverlayColor, clampOverlayBgOpacity, clampOverlayPollMs, OVERLAY_BG_COLOR_DEFAULT, isValidOverlayTheme, OVERLAY_THEME_DEFAULT, isValidOverlayRenderer } from './pure/overlay.ts';
// M17b (2c): the chip-name cut-down rules (pure; the boot names fetch
// derives the row labels from the sysinfo fixture/real names).
import { chipLabelGpu, chipLabelCpu } from './pure/chip-label.ts';
import { resolveBootDevice } from './pure/device.ts';
import { dedupeOverlayDevices, normalizeOverlayIdentityKey as identityToken, overlayDeviceOrder, overlayIdentityAliases as identityAliases, overlaySampleMatchesDevice as sampleMatchesDevice, overlayStableDeviceKey as stableDeviceKey, resolveOverlayMainDevice } from './pure/overlay-routing.ts';
import { pushSeries, trimSeriesWindow, autoScale, downsample } from './pure/graph.ts';
import type { SeriesPoint } from './pure/graph.ts';
import type { FpsSample, OverlayRenderer, TelemetrySample } from './types.ts';

/** The base font size at scale 1.0 (CSS px; overlay.css matches). */
const BASE_FONT_PX = 14;
/** The frametime series window: ~120 samples at the 1 s poll cadence (the
 *  pure/graph window seconds). The draw cap is the same count (120 - the
 *  downsample max; never more points than the window holds). */
const FRAMETIME_WINDOW_S = 120;
const FRAMETIME_DRAW_POINTS = 120;
/** Arc Power's own surface stays dark and readable over bright game scenes.
 * The legacy RTSS background color remains available to the native renderer,
 * but must not turn this hook-free surface light blue. */
const ARC_POWER_OVERLAY_BACKGROUND = 'rgba(27, 29, 46, 0.97)';

 let scale = 1;
 let latestSample: TelemetrySample | null = null;
// M35: CPU/RAM telemetry remains owned by the main selected-device lane.
// When the user monitors another GPU, its overlay lane supplies GPU fields
// while this source keeps CPU/RAM fields populated.
let latestCpuSource: TelemetrySample | null = null;
 // A secondary lane is keyed by the main-process device id. The primary
// M35: selected overlay devices are durable hardware keys. Null preserves the
// legacy all-GPU behavior; the resolved ids are refreshed on every settings
// push so enumeration order never becomes persisted state.
let overlayDeviceKeys: string[] | null = null;
let overlayDevices: Array<{ id: number; name?: string; deviceKey?: string | null; deviceKeys?: string[] | null; overlayOrdinal?: number }> = [];
let overlayDisplayDeviceId: number | null = null;
let overlayDisplayDeviceKey: string | null = null;
let overlayDisplayOrdinal = 1;
let mainSelectedDeviceId: number | null = null;
let mainSelectedDeviceKey: string | null = null;
let mainSelectedDevice: OverlayDeviceIdentity | null = null;
 // lane keeps the existing single-GPU rendering contract.
let secondaryDeviceIds: number[] = [];
let secondaryDeviceOrdinals: number[] = [];
const secondarySamples = new Map<string, TelemetrySample>();
let overlayConfigureGeneration = 0;
let overlayRequestGeneration = 0;
let latestFps: number | null = null;
// M7a: the latest percentile stats from the fps poll (null until the
// sampler reports them - the honest '-' fields on the FPS row).
let latestLow1Pct: number | null = null;
let latestP99: number | null = null;
// M12: the window AVG + the 0.1% Low ride the same poll (null when the
// sampler has not reached their frame floors - the honest '-' fields).
let latestAvgFps: number | null = null;
let latestLow01Pct: number | null = null;
// M10a: the latest foreground-window Graphics-API id from the same poll
// (null when nothing is detected - the API row stays empty; the sample's
// null-returning polls keep the last known value, like the fps itself).
let latestApi: string | null = null;
let series: SeriesPoint[] = [];
// RTSS exposes frame interval timing, which is the honest timing sample
// available to the hook-free renderer. Keep a second series so the layout can
// present Frametime and Displaytime independently when a richer sample is
// added later without changing the renderer contract.
let displaySeries: SeriesPoint[] = [];
// M6: the pushed color + stats (undefined until the first push -> the
// stock white + the full stat set - the overlayLines defaults).
let color: string = '#ffffff';
let stats: unknown = undefined;
// M17b (2c): the chip-name row labels - the pushed overlayChipNames flag +
// the boot names fetch (api.listDevices() + api.sysinfo() ONCE - the
// existing bootFpsLoop deviceGet is NOT a names fetch). The labels derive
// from the SY SINFO primary video-controller name + cpu.name (the plain
// 'Intel(R) Arc(TM) A770 Graphics' lives there - NOT listDevices, whose
// mock IGCL name is the fixture-decorated 'Mock Arc A770 Graphics
// (fixture)'; listDevices is the fallback only when sysinfo has no
// controllers). null until fetched -> the stock prefixes.
let chipNamesEnabled = false;
let cpuChipLabel: string | null = null;
let gpuChipLabel: string | null = null;
let secondaryGpuChipLabels: Array<string | null> = [];
type OverlayDeviceIdentity = {
  id: number;
  name?: string;
  deviceKey?: string | null;
  deviceKeys?: string[] | null;
  pciVendorId?: unknown;
  pciDeviceId?: unknown;
  bdf?: unknown;
  locationInfo?: unknown;
  pnpDeviceId?: string | null;
  overlayOrdinal?: number;
  displayActive?: boolean | null;
  osController?: { pnpDeviceId?: string | null; pciVendorId?: unknown; pciDeviceId?: unknown; bdf?: unknown; locationInfo?: unknown; displayActive?: boolean | null } | null;
};
type OverlaySysinfoController = {
  name?: string | null;
  pnpDeviceId?: string | null;
  pciVendorId?: unknown;
  pciDeviceId?: unknown;
  bdf?: unknown;
  locationInfo?: unknown;
};
const sysinfoGpuLabels = new Map<string, string>();
let sysinfoControllersByPnp: Map<string, OverlaySysinfoController[]> | null = null;

function deviceIdentity(device: OverlayDeviceIdentity): string | null {
  // gpu-inventory device keys intentionally carry a namespace (`pnp:<id>`),
  // while sysinfo exposes the raw PNP id. Prefer the authoritative OS row and
  // normalize the namespace before joining labels, especially for secondary
  // GPUs. Duplicate PNP rows also carry their BDF/PCI proof so their cache
  // entries cannot overwrite each other. No ordinal fallback is valid.
  const composite = physicalIdentityKey(device);
  if (composite) return composite;
  const key = identityToken(device.deviceKey);
  return key?.startsWith('PNP:') ? key.slice(4) : key;
}

function normalizedPciId(value: unknown): string | null {
  const text = typeof value === 'number' && Number.isInteger(value)
    ? value.toString(16)
    : typeof value === 'string' ? value.trim().replace(/^0x/i, '') : '';
  return /^[0-9a-f]{1,8}$/i.test(text) ? text.toUpperCase().slice(-4).padStart(4, '0') : null;
}

function normalizedBdf(value: unknown): string | null {
  if (typeof value === 'string') {
    const direct = value.trim().match(/^(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,2}):([0-9a-f]{1,2})\.([0-7])$/i);
    if (direct) {
      return `${Number.parseInt(direct[1] ?? '0', 16).toString(16).padStart(4, '0')}:${Number.parseInt(direct[2], 16).toString(16).padStart(2, '0')}:${Number.parseInt(direct[3], 16).toString(16).padStart(2, '0')}.${direct[4]}`;
    }
    const location = value.match(/\bbus\s*(\d+)\s*,?\s*device\s*(\d+)\s*,?\s*function\s*(\d+)/i);
    if (location) {
      return `0000:${Number(location[1]).toString(16).padStart(2, '0')}:${Number(location[2]).toString(16).padStart(2, '0')}.${location[3]}`;
    }
  }
  if (value && typeof value === 'object') {
    const record = value as { bus?: unknown; device?: unknown; function?: unknown; func?: unknown; domain?: unknown; segment?: unknown };
    const bus = Number(record.bus);
    const device = Number(record.device);
    const fn = Number(record.function ?? record.func ?? 0);
    const domain = Number(record.domain ?? record.segment ?? 0);
    if ([bus, device, fn, domain].every(Number.isInteger) && bus >= 0 && device >= 0 && fn >= 0 && domain >= 0) {
      return `${domain.toString(16).padStart(4, '0')}:${bus.toString(16).padStart(2, '0')}:${device.toString(16).padStart(2, '0')}.${fn}`;
    }
  }
  return null;
}

function normalizedPciPair(value: OverlayDeviceIdentity | OverlaySysinfoController): string | null {
  const osController = 'osController' in value ? value.osController : null;
  const pnp = identityToken(value.pnpDeviceId ?? osController?.pnpDeviceId);
  const vendor = normalizedPciId(value.pciVendorId ?? osController?.pciVendorId)
    ?? pnp?.match(/(?:^|\\|&)VEN_([0-9A-F]{4})/i)?.[1]
    ?? null;
  const device = normalizedPciId(value.pciDeviceId ?? osController?.pciDeviceId)
    ?? pnp?.match(/(?:^|\\|&)DEV_([0-9A-F]{4})/i)?.[1]
    ?? null;
  return vendor && device ? `${vendor}:${device}` : null;
}

function explicitNormalizedPciPair(value: OverlayDeviceIdentity | OverlaySysinfoController): string | null {
  const osController = 'osController' in value ? value.osController : null;
  const vendor = normalizedPciId(value.pciVendorId ?? osController?.pciVendorId);
  const device = normalizedPciId(value.pciDeviceId ?? osController?.pciDeviceId);
  return vendor && device ? `${vendor}:${device}` : null;
}

function pnpNormalizedPciPair(value: OverlayDeviceIdentity | OverlaySysinfoController): string | null {
  const osController = 'osController' in value ? value.osController : null;
  const pnp = identityToken(value.pnpDeviceId ?? osController?.pnpDeviceId);
  const vendor = pnp?.match(/(?:^|\\|&)VEN_([0-9A-F]{4})/i)?.[1]?.toUpperCase();
  const device = pnp?.match(/(?:^|\\|&)DEV_([0-9A-F]{4})/i)?.[1]?.toUpperCase();
  return vendor && device ? `${vendor}:${device}` : null;
}

function physicalIdentityKey(value: OverlayDeviceIdentity | OverlaySysinfoController): string | null {
  const osController = 'osController' in value ? value.osController : null;
  const rawKey = 'deviceKey' in value ? identityToken(value.deviceKey) : null;
  const pnp = identityToken(value.pnpDeviceId ?? osController?.pnpDeviceId)
    ?? (rawKey?.startsWith('PNP:') ? rawKey.slice(4) : null);
  const bdf = normalizedBdf(value.bdf ?? value.locationInfo ?? osController?.bdf ?? osController?.locationInfo);
  const pci = normalizedPciPair(value);
  const physical = bdf ? `bdf:${bdf}` : pci ? `pci:${pci}` : null;
  if (pnp && physical) return `pnp:${pnp}|${physical}`;
  if (pnp) return `pnp:${pnp}`;
  if (physical) return physical;
  return null;
}

function stableIdentityParts(value: OverlayDeviceIdentity | OverlaySysinfoController) {
  const osController = 'osController' in value ? value.osController : null;
  const pnpValues = [value.pnpDeviceId, osController?.pnpDeviceId]
    .map(identityToken)
    .filter((v): v is string => v !== null);
  const bdfValues = [
    value.bdf,
    value.locationInfo,
    osController?.bdf,
    osController?.locationInfo,
  ].map(normalizedBdf).filter((v): v is string => v !== null);
  const explicitPci = [explicitNormalizedPciPair(value)].filter((v): v is string => v !== null);
  const pnpPci = pnpValues.map(() => pnpNormalizedPciPair(value)).filter((v): v is string => v !== null);
  const pciValues = [...explicitPci, ...pnpPci];
  const pnp = pnpValues[0] ?? null;
  const bdf = bdfValues[0] ?? null;
  const pci = pciValues[0] ?? null;
  return {
    pnp,
    bdf,
    pci,
    invalid: new Set(pnpValues).size > 1
      || new Set(bdfValues).size > 1
      || pciValues.some((candidate) => candidate !== pci),
  };
}

function stableIdentitiesAgree(
  device: OverlayDeviceIdentity,
  controller: OverlaySysinfoController,
): boolean {
  const left = stableIdentityParts(device);
  const right = stableIdentityParts(controller);
  if (left.invalid || right.invalid) return false;
  if (left.pnp && right.pnp && left.pnp !== right.pnp) return false;
  if (left.bdf && right.bdf && left.bdf !== right.bdf) return false;
  if (left.pci && right.pci && left.pci !== right.pci) return false;
  return true;
}

function uniqueDuplicatePnpController(
  device: OverlayDeviceIdentity,
  candidates: OverlaySysinfoController[],
): OverlaySysinfoController | undefined {
  const consistent = candidates.filter((controller) => stableIdentitiesAgree(device, controller));
  const deviceBdf = stableIdentityParts(device).bdf;
  const devicePci = stableIdentityParts(device).pci;
  if (!deviceBdf && !devicePci) return undefined;
  const bdfMatches = deviceBdf ? consistent.filter((controller) => {
    return stableIdentityParts(controller).bdf === deviceBdf;
  }) : [];
  const pciMatches = devicePci ? consistent.filter((controller) => {
    return stableIdentityParts(controller).pci === devicePci;
  }) : [];
  const uniqueMatches = [
    bdfMatches.length === 1 ? bdfMatches[0] : undefined,
    pciMatches.length === 1 ? pciMatches[0] : undefined,
  ].filter((controller): controller is OverlaySysinfoController => controller !== undefined);
  return uniqueMatches.length === 1 || (uniqueMatches.length === 2 && uniqueMatches[0] === uniqueMatches[1])
    ? uniqueMatches[0]
    : undefined;
}

function controllerForDevice(
  device: OverlayDeviceIdentity,
  controllersByPnp: Map<string, OverlaySysinfoController[]>,
): OverlaySysinfoController | undefined {
  const rawKey = identityToken(device.deviceKey);
  const pnp = identityToken(device.osController?.pnpDeviceId ?? device.pnpDeviceId)
    ?? (rawKey?.startsWith('PNP:') ? rawKey.slice(4) : null);
  const candidates = pnp ? controllersByPnp.get(pnp) : undefined;
  if (!candidates || candidates.length === 0) return undefined;
  if (candidates.length === 1) {
    return stableIdentitiesAgree(device, candidates[0]) ? candidates[0] : undefined;
  }
  return uniqueDuplicatePnpController(device, candidates);
}

function chipLabelForDevice(
  device: OverlayDeviceIdentity,
  controllersByPnp?: Map<string, OverlaySysinfoController[]>,
  resolvedPrimaryLabel?: string | null,
): string | null {
  const key = deviceIdentity(device);
  // Once sysinfo is available, an unresolved duplicate-PNP group must not
  // inherit a fallback label from another controller. A unique PNP row (or a
  // device with no stable identity at all) may still use its inventory name.
  if (controllersByPnp && key) {
    const pnp = identityToken(device.osController?.pnpDeviceId ?? device.pnpDeviceId);
    const candidates = pnp ? controllersByPnp.get(pnp) : undefined;
    if (candidates && !controllerForDevice(device, controllersByPnp)) return null;
  }
  const cached = key ? sysinfoGpuLabels.get(key) : undefined;
  if (cached) return cached;
  // An identity-less primary can still have an unambiguous sole sysinfo
  // controller. Preserve that resolved label through the final projection;
  // stable-identity rows continue to use their keyed cache or inventory
  // fallback, and secondary rows never receive this primary-only override.
  if (!key && resolvedPrimaryLabel) return resolvedPrimaryLabel;
  return chipLabelGpu(device.name ?? null);
}

function currentDisplayDevice(): OverlayDeviceIdentity | null {
  if (overlayDisplayDeviceKey) {
    const wanted = identityToken(overlayDisplayDeviceKey);
    const keyed = overlayDevices.find((device) => identityToken(stableDeviceKey(device)) === wanted);
    if (keyed) return keyed;
  }
  return overlayDevices.find((device) => device.id === overlayDisplayDeviceId) ?? null;
}

function distinctGpuLabels(primaryLabel: string | null, secondaryLabels: Array<string | null>): Array<string | null> {
  const usedGpuLabels = new Set<string>();
  if (primaryLabel) usedGpuLabels.add(primaryLabel);
  return secondaryLabels.map((label, index) => {
    if (!label || !usedGpuLabels.has(label)) {
      if (label) usedGpuLabels.add(label);
      return label;
    }
    // Two physical adapters may share one compact model label. Keep the
    // display-driving GPU concise and make later rows visibly distinct.
    const suffix = `${label} ${usedGpuLabels.has(`${label} Secondary`) ? index + 2 : 'Secondary'}`;
    usedGpuLabels.add(suffix);
    return suffix;
  });
}

function projectCurrentChipLabels(resolvedPrimaryLabel?: string | null): void {
  const primary = currentDisplayDevice();
  gpuChipLabel = primary
    ? chipLabelForDevice(primary, sysinfoControllersByPnp ?? undefined, resolvedPrimaryLabel)
    : null;
  secondaryGpuChipLabels = distinctGpuLabels(gpuChipLabel, secondaryDeviceIds.map((deviceId) => {
    const device = overlayDevices.find((candidate) => candidate.id === deviceId);
    return device ? chipLabelForDevice(device, sysinfoControllersByPnp ?? undefined) : null;
  }));
}
// M6-amd2: the latest derived frame time (the value line below the strip;
// null -> the honest '-').
let latestFrameTime: number | null = null;
// M17e: the telemetry push counter (the fast-rate pin's mocked-push-cadence
// surface - the ui-verify counts the pushed samples over a window).
let telemetryTicks = 0;
// M24: the pushed theme ('arc' the product default - the Intel-Arc harness;
// 'classic' the original HUD). Applied via the documentElement dataset
// (CSP-safe, the --overlay-color pattern) + picked by draw() for the canvas
// stroke (arc: a horizontal #7FE3FF -> #4C8DFF gradient; classic: the
// pushed color). The dataset.themeStroke flag exposes the stroke kind for
// the ui-verify pin.
let theme: 'classic' | 'arc' = OVERLAY_THEME_DEFAULT;
let overlayRenderer: OverlayRenderer = 'rtss';
let softwareRenderer = false;
let overlayEnabled = false;

const fpsEl = document.getElementById('overlay-fps') as HTMLElement;
const cpuEl = document.getElementById('overlay-cpu') as HTMLElement;
const extraRowsEl = document.getElementById('overlay-secondary-rows') as HTMLElement | null;
const memoryEl = document.getElementById('overlay-memory') as HTMLElement;
const gpuEl = document.getElementById('overlay-gpu') as HTMLElement;
const vramEl = document.getElementById('overlay-vram') as HTMLElement;
const gpu2El = document.getElementById('overlay-gpu2') as HTMLElement;
const vram2El = document.getElementById('overlay-vram2') as HTMLElement;
// M13: the standalone Graphics-API row (the same fixed-div pattern - the
// api field LEFT the FPS row and renders here, between the VRAM row and
// the frametime strip).
const apiEl = document.getElementById('overlay-api') as HTMLElement;
const canvas = document.getElementById('overlay-frametime') as HTMLCanvasElement;
const valueEl = document.getElementById('overlay-frametime-value') as HTMLElement;
// M18/M19b: the header divider - ONE absolutely-positioned 1px line behind
// the SIX labeled rows (the root is its containing block; the divider's
// top/bottom get set from the row offsets per render, the left comes from
// the CSS calc carrying the --overlay-label-w var).
const rootEl = document.getElementById('overlay-root') as HTMLElement;
const dividerEl = document.getElementById('overlay-divider');
const capframexRoot = document.getElementById('capframex-root');
const capframexGpuSections = document.getElementById('capframex-gpu-sections');
const capframexCpuTitle = document.getElementById('capframex-cpu-title');
const capframexMemory = document.getElementById('capframex-memory');
const capframexMemoryRow = document.querySelector<HTMLElement>('.capframex-memory-row');
const capframexApi = document.getElementById('capframex-api');
const capframexApiRow = document.getElementById('capframex-api-row');
const capframexSummary = document.querySelector<HTMLElement>('.capframex-summary');
const capframexAvg = document.getElementById('capframex-avg');
const capframexLow1 = document.getElementById('capframex-low1');
const capframexLow01 = document.getElementById('capframex-low01');
const capframexP99 = document.getElementById('capframex-p99');
const capframexPerformance = document.getElementById('capframex-performance');
const capframexPerformanceFt = document.getElementById('capframex-performance-ft');
const capframexFrametimeCard = document.getElementById('capframex-frametime-card');
const capframexDisplaytimeCard = document.getElementById('capframex-displaytime-card');
const capframexFrametimeCanvas = document.getElementById('capframex-frametime') as HTMLCanvasElement | null;
const capframexDisplaytimeCanvas = document.getElementById('capframex-displaytime') as HTMLCanvasElement | null;
const capframexFrametimeValue = document.getElementById('capframex-frametime-value');
const capframexDisplaytimeValue = document.getElementById('capframex-displaytime-value');
const capframexFrametimeAxisTop = document.getElementById('capframex-frametime-axis-top');
const capframexFrametimeAxisBottom = document.getElementById('capframex-frametime-axis-bottom');
const capframexDisplaytimeAxisTop = document.getElementById('capframex-displaytime-axis-top');
const capframexDisplaytimeAxisBottom = document.getElementById('capframex-displaytime-axis-bottom');

function clearOverlaySampling(): void {
  latestFps = null;
  latestLow1Pct = null;
  latestP99 = null;
  latestAvgFps = null;
  latestLow01Pct = null;
  latestApi = null;
  latestFrameTime = null;
  series = [];
  displaySeries = [];
  latestSample = null;
  latestCpuSource = null;
  secondarySamples.clear();
}

// M3: registered SYNCHRONOUSLY at script top - BEFORE any await - so the
// initial 'overlay:settings' push (main sends it right after
// did-finish-load) is never missed by the boot sequence.
api.onOverlaySettings((settings) => {
  const s = settings ?? {};
  scale = clampOverlayScale(s.scale);
  const previousRenderer = overlayRenderer;
  const previousEnabled = overlayEnabled;
  overlayRenderer = isValidOverlayRenderer(s.renderer) ? s.renderer : 'rtss';
  softwareRenderer = s.softwareRenderer === true;
  overlayEnabled = s.enabled === true;
  document.documentElement.dataset.overlayRenderer = overlayRenderer;
  if (capframexRoot) capframexRoot.setAttribute('aria-hidden', overlayRenderer === 'capframex' ? 'false' : 'true');
  // The CSSOM font-size scaling (CSP-safe): one change scales every rem
  // size in the HUD - the same persisted scale the window was resized with.
  document.documentElement.style.fontSize = `${BASE_FONT_PX * scale}px`;
  // M6: the text color - ONE CSS var on <html>, read by overlay.css for
  // the line color + by draw() for the canvas stroke (a non-white color
  // must recolor BOTH - the old hardcoded '#ffffff' stroke would betray a
  // color change). Garbage degrades to the stock white.
  color = isValidOverlayColor(s.color) ? s.color : '#ffffff';
  document.documentElement.style.setProperty('--overlay-color', color);
  document.documentElement.style.setProperty('--capframex-accent', color);
  // M7b (fix 4): the background box - the two CSS vars via CSSOM (the
  // same CSP-safe pattern) + the .visible class from overlayBgEnabled.
  // The backdrop exists in the fixed overlay.html markup; a bg change
  // re-renders on THIS push (main's applyOverlaySettings forwards the
  // three fields - without them the defaults would always push and the
  // box would never appear).
  document.documentElement.style.setProperty(
    '--overlay-bg-color',
    isValidOverlayColor(s.overlayBgColor) ? s.overlayBgColor : OVERLAY_BG_COLOR_DEFAULT,
  );
  document.documentElement.style.setProperty(
    '--overlay-bg-opacity',
    String(clampOverlayBgOpacity(s.overlayBgOpacity)),
  );
  const capframexBgColor = isValidOverlayColor(s.overlayBgColor) ? s.overlayBgColor : OVERLAY_BG_COLOR_DEFAULT;
  const capframexBgOpacity = clampOverlayBgOpacity(s.overlayBgOpacity);
  // Arc Power Overlay owns a fixed dark blue-purple surface. The legacy RTSS
  // background controls remain available for the native renderer, but must
  // not tint this hook-free surface with a saved light-blue color.
  const capframexBackground = ARC_POWER_OVERLAY_BACKGROUND;
  document.documentElement.style.setProperty(
    '--capframex-bg',
    capframexBackground,
  );
  // M35: monitoring selection is a live setting. Refresh the inventory before
  // applying it: numeric session ids can be reassigned after a driver reset
  // or device hotplug, so reusing the boot list could route the overlay to a
  // different physical GPU. The durable display key anchors the primary row
  // when the enumeration order changes.
  overlayDeviceKeys = Array.isArray(s.deviceKeys)
    ? s.deviceKeys.filter((key: unknown): key is string => typeof key === 'string' && key.length > 0)
    : null;
  const softwareRendererSelected = overlayRenderer === 'capframex' || softwareRenderer;
  const requestGeneration = ++overlayRequestGeneration;
  if (softwareRendererSelected && overlayEnabled) {
    void api.listDevices().then(async (devices) => {
      // The initial settings push can race bootNamesFetch(). If no live
      // selection has reached this renderer yet, read the durable main-device
      // identity before configuring lanes instead of treating the display GPU
      // as the main owner by default.
      let mainSelection = { deviceId: mainSelectedDeviceId ?? fpsDeviceId, deviceKey: mainSelectedDeviceKey };
      if (mainSelectedDeviceId === null && mainSelectedDeviceKey === null) {
        try {
          const persistedSelection = await api.deviceGet();
          if (requestGeneration !== overlayRequestGeneration) return;
          const persistedId = typeof persistedSelection?.deviceId === 'number'
            ? persistedSelection.deviceId
            : fpsDeviceId;
          const persistedKey = typeof persistedSelection?.deviceKey === 'string'
            ? persistedSelection.deviceKey
            : null;
          mainSelectedDeviceId = persistedId;
          mainSelectedDeviceKey = persistedKey;
          mainSelectedDevice = null;
          mainSelection = { deviceId: persistedId, deviceKey: persistedKey };
        } catch {
          // The FPS/display identity remains the compatibility fallback.
        }
      }
      const primary = overlayDisplayDeviceKey
        ? devices.find((device) => identityAliases(device).some((key) => key === identityToken(overlayDisplayDeviceKey)))
        : devices.find((device) => device.id === fpsDeviceId);
      return configureOverlayDevices(primary?.id ?? fpsDeviceId, devices, mainSelection, requestGeneration);
    }).catch(() => {
      // Keep the last working inventory if a transient refresh fails.
      void configureOverlayDevices(fpsDeviceId, overlayDevices, {
        deviceId: mainSelectedDeviceId ?? fpsDeviceId,
        deviceKey: mainSelectedDeviceKey,
      }, requestGeneration);
    });
  } else {
    // RTSS owns the native HUD in this mode. Release only this renderer's
    // optional telemetry owner so the hidden Electron document does not keep
    // sampling hardware or duplicate the RTSS lanes. The same release path is
    // used when the optional renderer is disabled, so turning the master
    // toggle off stops both telemetry ownership and FPS polling immediately.
    overlayRequestGeneration += 1;
    overlayConfigureGeneration += 1;
    void api.overlayTelemetryStart({ owner: 'overlay', deviceKeys: [] }).catch(() => {});
    if (!overlayEnabled) clearOverlaySampling();
  }
  const backdrop = document.getElementById('overlay-backdrop');
  if (backdrop) backdrop.classList.toggle('visible', s.overlayBgEnabled === true);
  // M6: the enabled stats - an absent value means the DEFAULT set (M17g:
  // the user's 11 ON / the others OFF - the M6 full-set default FLIPS;
  // overlayLines normalizes).
  stats = s.stats;
  // M17b (2c): the chip-name row labels flag - on -> the boot-derived
  // labels replace the stock 'CPU '/'GPU ' prefixes (null labels degrade
  // to the stock prefixes inside overlayLines).
  chipNamesEnabled = s.overlayChipNames === true;
  // M17e: the pushed polling-rate - the renderer carries the clamped value
  // on the documentElement dataset (the ui-verify payload pin's surface;
  // the cadence itself is main-side).
  const pollMs = clampOverlayPollMs(s.overlayPollMs);
  document.documentElement.dataset.overlayPollMs = String(pollMs);
  // M24: the overlay theme - the documentElement dataset drives the arc CSS
  // block (the harness vs the classic HUD); garbage degrades to the 'arc'
  // product default. The renderer applies the theme from the push (the M7
  // single-source-of-truth rule - the push and the window are applied
  // together).
  theme = isValidOverlayTheme(s.theme) ? s.theme : OVERLAY_THEME_DEFAULT;
  document.documentElement.dataset.overlayTheme = theme;
  document.documentElement.dataset.themeStroke = theme === 'arc' ? 'gradient' : 'flat';
  // M17f: the FPS-poll cadence follows the SAME slider - the bootFpsLoop
  // re-arms its interval when the pushed value changes (the FPS line then
  // updates at the user's chosen rate, not the stock 1000 ms).
  applyFpsPollMs(pollMs);
  if (previousRenderer !== overlayRenderer || previousEnabled !== overlayEnabled) armFpsLoop();
  sizeCanvas();
  render();
});

function sizeCanvas(): void {
  // Match the canvas bitmap to its scaled CSS size (the polyline spans the
  // full scaled width).
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

// Supplementary layout resynchronization for later font/window changes. The
// render path above remains the authoritative synchronous visibility fix.
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    sizeCanvas();
    draw();
  }).observe(canvas);
}
window.addEventListener('resize', () => {
  sizeCanvas();
  draw();
});

function renderedLabel(line: string): string {
  if (!line) return '';
  const separator = line.indexOf('  ');
  return (separator >= 0 ? line.slice(0, separator) : line).trimEnd();
}

function numberedLabel(line: string, label: 'GPU' | 'VRAM', number: number | null): string {
  const current = renderedLabel(line);
  return number !== null && current === label ? `${label}${number}` : current;
}

function numberedRow(line: string, label: 'GPU' | 'VRAM', number: number, labelWidth: number): string {
  // Chip-name mode keeps the human-readable chip label. Numbered prefixes
  // are the default surface requested for multi-adapter systems. Rebuild the
  // row from its fields so the numbered label uses the same shared column as
  // every other primary/secondary row.
  if (renderedLabel(line) !== label) return line;
  const separator = line.indexOf('  ');
  const fields = separator >= 0 ? line.slice(separator).trim() : '';
  const numbered = `${label}${number}`;
  return `${numbered.padEnd(Math.max(labelWidth, numbered.length))}  ${fields}`;
}

type SecondaryRowElements = { gpu: HTMLElement; vram: HTMLElement };
const extraRowElements: SecondaryRowElements[] = [];

function ensureExtraRows(count: number): void {
  if (!extraRowsEl) return;
  while (extraRowElements.length < count) {
    const gpu = document.createElement('div');
    const vram = document.createElement('div');
    gpu.className = 'overlay-line overlay-secondary';
    vram.className = 'overlay-line overlay-secondary';
    extraRowsEl.append(gpu, vram);
    extraRowElements.push({ gpu, vram });
  }
  extraRowElements.forEach((row, index) => {
    row.gpu.style.display = index < count ? 'block' : 'none';
    row.vram.style.display = index < count ? 'block' : 'none';
  });
}

function positionOverlayDivider(maxLabelLen: number): void {
  if (!dividerEl) return;
  const rows = [
    fpsEl, cpuEl, memoryEl, gpuEl, vramEl, apiEl,
    gpu2El, vram2El, ...extraRowElements.flatMap((row) => [row.gpu, row.vram]),
  ];
  const row = rows.find((candidate) => {
    const node = candidate.firstChild;
    return getComputedStyle(candidate).display !== 'none'
      && node?.nodeType === Node.TEXT_NODE
      && (node.textContent?.length ?? 0) >= maxLabelLen + 2;
  });
  const node = row?.firstChild;
  if (!row || !node || node.nodeType !== Node.TEXT_NODE) {
    dividerEl.style.removeProperty('left');
    return;
  }

  // CSS `ch` is usually sufficient, but it can drift from the actual text
  // column when the overlay is scaled or a platform substitutes a font. Use
  // the rendered text boundary as the source of truth: the line stays after
  // the label and before the two-space value separator at every scale.
  const textNode = node as Text;
  const boundary = (offset: number): number => {
    const range = document.createRange();
    const safeOffset = Math.max(0, Math.min(offset, textNode.length));
    range.setStart(textNode, safeOffset);
    range.setEnd(textNode, safeOffset);
    return range.getBoundingClientRect().left;
  };
  const labelEnd = boundary(maxLabelLen);
  const afterFirstSpace = boundary(maxLabelLen + 1);
  const charWidth = afterFirstSpace - labelEnd;
  if (!Number.isFinite(labelEnd) || !(charWidth > 0)) {
    dividerEl.style.removeProperty('left');
    return;
  }
  const rootRect = rootEl.getBoundingClientRect();
  dividerEl.style.left = `${Math.max(0, labelEnd - rootRect.left + charWidth * 0.75)}px`;
}

function capNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function capValue(value: unknown, suffix: string, decimals = 0): string {
  const n = capNumber(value);
  if (n === null) return '-';
  const text = decimals > 0 ? n.toFixed(decimals) : String(Math.round(n));
  return `${text}${suffix}`;
}

function capGb(value: unknown): number | null {
  const n = capNumber(value);
  return n === null ? null : n / 1e9;
}

function capGpuTitle(sample: TelemetrySample | null, device: OverlayDeviceIdentity | null, ordinal: number): string {
  const raw = sample?.deviceName ?? device?.name ?? null;
  const model = chipLabelGpu(raw) ?? (typeof raw === 'string' && raw.trim() ? raw.trim() : `GPU ${ordinal}`);
  const arc = typeof raw === 'string' && /\barc\b/i.test(raw) ? 'Arc ' : '';
  return `${ordinal > 1 ? `GPU ${ordinal} · ` : ''}${arc}${model} Graphics`;
}

function capRow(parent: HTMLElement, label: string, values: string[]): void {
  const row = document.createElement('div');
  row.className = 'capframex-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'capframex-label';
  labelEl.textContent = label;
  row.append(labelEl);
  for (const value of values) {
    const valueEl = document.createElement('span');
    valueEl.textContent = value;
    row.append(valueEl);
  }
  parent.append(row);
}

function capStatRow(parent: HTMLElement, enabled: Set<string>, statId: string, label: string, values: string[]): void {
  if (enabled.has(statId)) capRow(parent, label, values);
}

function capCanvasSize(canvasEl: HTMLCanvasElement | null): void {
  if (!canvasEl) return;
  const rect = canvasEl.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (canvasEl.width !== width) canvasEl.width = width;
  if (canvasEl.height !== height) canvasEl.height = height;
}

function drawCapSeries(
  canvasEl: HTMLCanvasElement | null,
  points: SeriesPoint[],
  stroke: string,
  axisTop: HTMLElement | null,
  axisBottom: HTMLElement | null,
): void {
  if (!canvasEl) return;
  capCanvasSize(canvasEl);
  const ctx = canvasEl.getContext('2d');
  if (!ctx) return;
  const setAxis = (high: number): void => {
    if (axisTop) axisTop.textContent = `${high.toFixed(1)}ms`;
    if (axisBottom) axisBottom.textContent = '0.0ms';
  };
  setAxis(25);
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  if (points.length === 0) return;
  const drawn = downsample(points, 120);
  const values = drawn.map((point) => point.v).filter((value) => Number.isFinite(value));
  if (values.length === 0) return;
  // Keep the Arc Power chart on a stable 0-25 ms frame-time scale until a
  // sample exceeds it. The scale then expands in 5 ms steps and the visible
  // axis label follows, so stutter peaks remain honest instead of vanishing
  // outside the canvas.
  const low = 0;
  const high = Math.max(25, Math.ceil(Math.max(...values) / 5) * 5);
  setAxis(high);
  const range = Math.max(0.01, high - low);
  const x = (index: number): number => drawn.length <= 1
    ? canvasEl.width / 2
    : (index / (drawn.length - 1)) * canvasEl.width;
  const y = (value: number): number => canvasEl.height - ((value - low) / range) * canvasEl.height;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  drawn.forEach((point, index) => {
    if (index === 0) ctx.moveTo(x(index), y(point.v));
    else ctx.lineTo(x(index), y(point.v));
  });
  ctx.stroke();
}

function renderCapframex(displaySample: TelemetrySample | null): void {
  if (!capframexGpuSections) return;
  const enabled = new Set(normalizeOverlayStats(stats));
  capframexGpuSections.replaceChildren();
  const primary = currentDisplayDevice();
  const gpuEntries: Array<{ sample: TelemetrySample | null; device: OverlayDeviceIdentity | null; ordinal: number }> = [
    { sample: displaySample, device: primary, ordinal: overlayDisplayOrdinal || 1 },
  ];
  secondaryDeviceIds.forEach((deviceId, index) => {
    const device = overlayDevices.find((candidate) => candidate.id === deviceId) ?? null;
    gpuEntries.push({
      sample: device ? secondarySamples.get(stableDeviceKey(device)) ?? null : null,
      device,
      ordinal: secondaryDeviceOrdinals[index] ?? index + 2,
    });
  });
  gpuEntries.forEach(({ sample, device, ordinal }) => {
    const section = document.createElement('section');
    section.className = 'capframex-section capframex-gpu-section';
    const title = document.createElement('div');
    title.className = 'capframex-gpu-title';
    const name = document.createElement('span');
    name.textContent = capGpuTitle(sample, device, ordinal);
    const clocks = document.createElement('span');
    clocks.className = 'capframex-clock';
    if (enabled.has('gpu-clock')) {
      clocks.textContent = capValue(sample?.gpuClockMhz, ' MHz');
      title.append(clocks);
    }
    if (enabled.has('gpu-mem-clock')) {
      const memClock = document.createElement('span');
      memClock.className = 'capframex-memory-clock';
      memClock.textContent = capValue(sample?.memClockMhz, ' MHz');
      title.append(memClock);
    }
    title.prepend(name);
    section.append(title);
    capStatRow(section, enabled, 'gpu-util', 'GPU Load', [capValue(sample?.utilPct ?? sample?.gpuUtilPct, ' %')]);
    capStatRow(section, enabled, 'gpu-temp', 'GPU Temp', [capValue(sample?.tempC, ' °C')]);
    capStatRow(section, enabled, 'gpu-voltage', 'GPU Voltage', [capValue(sample?.gpuVoltageV, ' V', 3)]);
    capStatRow(section, enabled, 'gpu-power', 'GPU Power', [capValue(sample?.powerW, ' W', 1)]);
    capStatRow(section, enabled, 'gpu-fan', 'GPU Fan', [capValue(sample?.fanRpm?.[0], ' RPM')]);
    capStatRow(section, enabled, 'gpu-vram', 'VRAM', [capValue(capGb(sample?.gpuMemUsedBytes), ' GB', 1)]);
    capStatRow(section, enabled, 'gpu-vram-temp', 'VRAM Temp', [capValue(sample?.vramTempC ?? sample?.memTempC, ' °C')]);
    capframexGpuSections.append(section);
  });

  if (capframexCpuTitle) {
    const cpuLabel = document.createElement('span');
    cpuLabel.className = 'capframex-title-label';
    cpuLabel.textContent = 'CPU Model';
    const cpuValue = document.createElement('span');
    cpuValue.className = 'capframex-title-value';
    cpuValue.textContent = cpuChipLabel || '-';
    capframexCpuTitle.replaceChildren(cpuLabel, cpuValue);
  }
  const cpuSection = capframexCpuTitle?.parentElement;
  if (cpuSection) {
    [...cpuSection.querySelectorAll<HTMLElement>('.capframex-row')].forEach((row) => row.remove());
    capStatRow(cpuSection, enabled, 'cpu-clock', 'CPU Max', [capValue(displaySample?.cpuFreqMhz, ' MHz')]);
    capStatRow(cpuSection, enabled, 'cpu-util', 'CPU Total', [capValue(displaySample?.cpuUtilPct, ' %')]);
    const packageValues = [capValue(displaySample?.cpuPowerW, ' W', 1)];
    if (enabled.has('cpu-temp')) packageValues.push(capValue(displaySample?.cpuTempC, ' °C'));
    capStatRow(cpuSection, enabled, 'cpu-power', 'CPU Package', packageValues);
    if (enabled.has('cpu-temp') && !enabled.has('cpu-power')) capStatRow(cpuSection, enabled, 'cpu-temp', 'CPU Temp', [capValue(displaySample?.cpuTempC, ' °C')]);
  }
  if (capframexMemory) capframexMemory.textContent = capValue(capGb(displaySample?.memoryUsedBytes), ' GB', 1);
  if (capframexMemoryRow) capframexMemoryRow.hidden = !enabled.has('memory-util');
  if (capframexApi) capframexApi.textContent = latestApi ?? '';
  if (capframexApiRow) capframexApiRow.hidden = !enabled.has('api') || !latestApi;
  if (capframexAvg) capframexAvg.textContent = capValue(latestAvgFps, ' FPS');
  if (capframexLow1) capframexLow1.textContent = capValue(latestLow1Pct, ' FPS');
  if (capframexLow01) capframexLow01.textContent = capValue(latestLow01Pct, ' FPS');
  if (capframexP99) capframexP99.textContent = capValue(latestP99, ' FPS');
  if (capframexPerformance) capframexPerformance.textContent = capValue(latestFps, ' FPS');
  if (capframexPerformanceFt) capframexPerformanceFt.textContent = enabled.has('frametime') ? capValue(latestFrameTime, ' ms', 1) : '';
  if (capframexFrametimeValue) capframexFrametimeValue.textContent = capValue(latestFrameTime, ' ms', 1);
  if (capframexDisplaytimeValue) capframexDisplaytimeValue.textContent = capValue(latestFrameTime, ' ms', 1);
  if (capframexSummary) {
    capframexSummary.hidden = !['fps', 'fps-avg', 'fps-1pct-low', 'fps-01pct-low', 'fps-99pct', 'frametime'].some((id) => enabled.has(id));
    const summaryItems = capframexSummary.querySelectorAll<HTMLElement>(':scope > div');
    const summaryIds = ['fps-avg', 'fps-1pct-low', 'fps-01pct-low', 'fps-99pct', 'fps'];
    summaryItems.forEach((item, index) => { item.hidden = !enabled.has(summaryIds[index]); });
  }
  if (capframexFrametimeCard) capframexFrametimeCard.hidden = !enabled.has('frametime');
  if (capframexDisplaytimeCard) capframexDisplaytimeCard.hidden = !enabled.has('frametime');
  drawCapSeries(capframexFrametimeCanvas, series, '#5bd5ff', capframexFrametimeAxisTop, capframexFrametimeAxisBottom);
  // RTSS supplies frame interval timing rather than a separate present-time
  // counter. Keep the second chart honest by mirroring that source until a
  // provider exposes a distinct display-time field.
  drawCapSeries(capframexDisplaytimeCanvas, displaySeries, '#5bd5ff', capframexDisplaytimeAxisTop, capframexDisplaytimeAxisBottom);
}

function render(): void {
  const displaySample = latestCpuSource
    ? { ...latestCpuSource, ...(latestSample ?? {}) }
    : latestSample;
  if (overlayRenderer === 'capframex') {
    renderCapframex(displaySample);
    return;
  }
  const lines = overlayLines(
    displaySample, latestFps, stats, latestLow1Pct, latestP99, latestApi,
    latestAvgFps, latestLow01Pct, displaySample?.memoryUsedBytes ?? null,
    chipNamesEnabled ? { chipLabels: { cpu: cpuChipLabel, gpu: gpuChipLabel } } : undefined,
  );
  const hasSecondary = secondaryDeviceIds.length > 0;
  const primaryOrdinal = overlayDisplayOrdinal > 0 ? overlayDisplayOrdinal : 1;
  const showPrimaryNumber = hasSecondary || primaryOrdinal !== 1;
  const primaryNumber = showPrimaryNumber ? primaryOrdinal : null;
  ensureExtraRows(Math.max(0, secondaryDeviceIds.length - 1));
  const secondaryRows = secondaryDeviceIds.map((deviceId, index) => {
    const secondaryDevice = overlayDevices.find((device) => device.id === deviceId) ?? null;
    const secondary = secondaryDevice ? secondarySamples.get(stableDeviceKey(secondaryDevice)) ?? null : null;
    const secondaryLines = overlayLines(
      secondary, null, stats, null, null, null, null, null,
      secondary?.memoryUsedBytes ?? null,
      chipNamesEnabled
        ? { chipLabels: { cpu: null, gpu: secondaryGpuChipLabels[index] ?? null } }
        : undefined,
    );
    return {
      index,
      ordinal: secondaryDeviceOrdinals[index] ?? index + 2,
      sample: secondary,
      lines: secondaryLines,
      gpuLabel: secondaryGpuChipLabels[index] ?? null,
      row: index === 0 ? { gpu: gpu2El, vram: vram2El } : extraRowElements[index - 1],
    };
  });

  // The divider and every value column must be driven by one width. Measuring
  // only the primary labels lets a long secondary chip name cross the line;
  // measuring after separate formatting merely moves the divider and leaves
  // the values behind. Collect the labels before padding, including the
  // numbered prefixes used when chip names are off.
  const labelLengths = [
    renderedLabel(lines.fpsLine).length,
    renderedLabel(lines.cpuLine).length,
    renderedLabel(lines.memoryLine).length,
    numberedLabel(lines.gpuLine, 'GPU', chipNamesEnabled ? null : primaryNumber).length,
    numberedLabel(lines.vramLine, 'VRAM', chipNamesEnabled ? null : primaryNumber).length,
    renderedLabel(lines.apiLine).length,
    ...secondaryRows.flatMap(({ lines: secondaryLines, ordinal }) => [
      numberedLabel(secondaryLines.gpuLine, 'GPU', chipNamesEnabled ? null : ordinal).length,
      numberedLabel(secondaryLines.vramLine, 'VRAM', chipNamesEnabled ? null : ordinal).length,
    ]),
  ];
  const maxLabelLen = Math.max(4, ...labelLengths);
  const primaryOptions = chipNamesEnabled
    ? { chipLabels: { cpu: cpuChipLabel, gpu: gpuChipLabel }, labelWidth: maxLabelLen }
    : { labelWidth: maxLabelLen };
  const paddedLines = overlayLines(
    displaySample, latestFps, stats, latestLow1Pct, latestP99, latestApi,
    latestAvgFps, latestLow01Pct, displaySample?.memoryUsedBytes ?? null,
    primaryOptions,
  );
  const paddedSecondaryRows = secondaryRows.map(({ sample, gpuLabel, index, ordinal }) => {
    const options = chipNamesEnabled
      ? { chipLabels: { cpu: null, gpu: gpuLabel }, labelWidth: maxLabelLen }
      : { labelWidth: maxLabelLen };
    return {
      index,
      ordinal,
      lines: overlayLines(
        sample, null, stats, null, null, null, null, null,
        sample?.memoryUsedBytes ?? null,
        options,
      ),
    };
  });

  fpsEl.textContent = paddedLines.fpsLine;
  cpuEl.textContent = paddedLines.cpuLine;
  memoryEl.textContent = paddedLines.memoryLine;
  gpuEl.textContent = primaryNumber === null ? paddedLines.gpuLine : numberedRow(paddedLines.gpuLine, 'GPU', primaryNumber, maxLabelLen);
  vramEl.textContent = primaryNumber === null ? paddedLines.vramLine : numberedRow(paddedLines.vramLine, 'VRAM', primaryNumber, maxLabelLen);
  gpu2El.style.display = hasSecondary ? 'block' : 'none';
  vram2El.style.display = hasSecondary ? 'block' : 'none';
  gpu2El.textContent = '';
  vram2El.textContent = '';
  for (const { index, ordinal, lines: secondaryLines } of paddedSecondaryRows) {
    const row = index === 0 ? { gpu: gpu2El, vram: vram2El } : extraRowElements[index - 1];
    row.gpu.textContent = chipNamesEnabled
      ? secondaryLines.gpuLine
      : numberedRow(secondaryLines.gpuLine, 'GPU', ordinal, maxLabelLen);
    row.vram.textContent = numberedRow(secondaryLines.vramLine, 'VRAM', ordinal, maxLabelLen);
  }
  apiEl.textContent = paddedLines.apiLine;
  // M6/M6-amd2: the frametime stat is NOT a line - it toggles the canvas
  // strip's AND the value line's visibility together (a fully-off line
  // writes '' into its KEPT div, but the strip + the number are HIDDEN -
  // an empty 31rem strip / a stale number would still occupy space).
  canvas.style.display = paddedLines.frametimeEnabled ? '' : 'none';
  valueEl.style.display = paddedLines.frametimeEnabled ? '' : 'none';
  // The value line: the latest derived frame time (max 2 decimals; the
  // honest '-' when the last poll had nothing to derive from).
  valueEl.textContent = paddedLines.frametimeEnabled ? formatFrametime(latestFrameTime) : '';
  // M18/M19b: the header-divider column - the --overlay-label-w CSS var in
  // ch (WITH the unit - '4ch' / '9ch', never a bare number: a unit-less
  // value inside the calc is invalid at computed-value time) from the same
  // shared max passed to every formatter above. Physical GPU ordinals widen
  // the column when a non-display adapter is selected on its own, as do the
  // multi-adapter rows and long secondary chip labels.
  document.documentElement.style.setProperty('--overlay-label-w', `${maxLabelLen}ch`);
  positionOverlayDivider(maxLabelLen);
  // M18/M19b: the divider's top/bottom - the FPS row's top to the API
  // row's bottom, relative to the root (measured like sizeCanvas() reads
  // the canvas rect - getBoundingClientRect, so it adapts to the scale and
  // to collapsed empty rows). M19b: the API row JOINED the divider column
  // - the line now spans fps -> api (the frametime strip stays BELOW the
  // divider's bottom).
  if (dividerEl) {
    const rootRect = rootEl.getBoundingClientRect();
    const fpsRect = fpsEl.getBoundingClientRect();
    const apiRect = apiEl.getBoundingClientRect();
    dividerEl.style.top = `${fpsRect.top - rootRect.top}px`;
    dividerEl.style.bottom = `${rootRect.bottom - apiRect.bottom}px`;
  }
  // The visibility transition must be ordered display -> backing bitmap -> draw.
  sizeCanvas();
  draw();
}

/** The frametime polyline - ONLY the 1.5px line (no grid, no background
 *  rect). The y axis auto-scales to the series (the pure/graph math). */
function draw(): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (series.length < 2) return;
  const range = autoScale(series);
  if (!range) return;
  const span = range.max - range.min;
  if (!(span > 0)) return;
  const drawn = downsample(series, FRAMETIME_DRAW_POINTS);
  const x = (i: number): number => (i / (drawn.length - 1)) * canvas.width;
  const y = (v: number): number => canvas.height - ((v - range.min) / span) * canvas.height;
  // M6: the stroke takes the SAME hex as the text lines (the pushed
  // overlayColor - never the old hardcoded '#ffffff').
  // M24: the ARC theme's stroke is the theme-owned horizontal gradient
  // (#7FE3FF -> #4C8DFF across the strip - the Intel Arc sweep); the
  // CLASSIC theme keeps the pushed color. The --overlay-color text setting
  // is orthogonal to the theme in BOTH cases (the user's color choice still
  // applies to the lines; only the stroke kind changes with the theme).
  if (theme === 'arc') {
    const g = ctx.createLinearGradient(0, 0, canvas.width, 0);
    g.addColorStop(0, '#7FE3FF');
    g.addColorStop(1, '#4C8DFF');
    ctx.strokeStyle = g;
  } else {
    ctx.strokeStyle = color;
  }
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  drawn.forEach((p, i) => {
    if (i === 0) ctx.moveTo(x(i), y(p.v));
    else ctx.lineTo(x(i), y(p.v));
  });
  ctx.stroke();
}

// The telemetry push (forwarded to BOTH windows by main's emit) feeds the
// stat lines. The overlay relies on the MAIN window's telemetry session -
// it keeps working while the main window is closed-to-tray (hidden, alive).
api.onTelemetrySample((sample) => {
  telemetryTicks += 1;
  document.documentElement.dataset.telemetryTicks = String(telemetryTicks);
  const displayDevice = overlayDisplayDeviceKey
    ? overlayDevices.find((device) => identityToken(stableDeviceKey(device)) === identityToken(overlayDisplayDeviceKey)) ?? null
    : overlayDevices.find((device) => device.id === overlayDisplayDeviceId) ?? null;
  const mainDevice = mainSelectedDeviceKey
    ? overlayDevices.find((device) => identityToken(stableDeviceKey(device)) === identityToken(mainSelectedDeviceKey))
      ?? mainSelectedDevice
    : overlayDevices.find((device) => device.id === mainSelectedDeviceId)
      ?? mainSelectedDevice;
  const sampleDeviceId = typeof sample.deviceId === 'number' ? sample.deviceId : null;
  const secondaryDevice = overlayDevices.find((device) => (
    secondaryDeviceIds.includes(device.id) && sampleMatchesDevice(sample, device)
  )) ?? null;
  const isMainSample = mainDevice ? sampleMatchesDevice(sample, mainDevice) : false;
  if (isMainSample && (
    Object.prototype.hasOwnProperty.call(sample, 'cpuUtilPct')
    || Object.prototype.hasOwnProperty.call(sample, 'memoryUsedBytes')
  )) {
    latestCpuSource = sample;
  }
  if (secondaryDevice) {
    secondarySamples.set(stableDeviceKey(secondaryDevice), sample);
  } else if (
    (displayDevice && sampleMatchesDevice(sample, displayDevice))
    || (!displayDevice && sampleDeviceId === null)
  ) {
    latestSample = sample;
  }
  render();
});

// M3b: the fps poll runs on its OWN loop (the overlay keeps working when
// the main window is closed-to-tray - no dependency on the Monitoring
// page). The deviceId resolves via device-get at boot; the poll is SKIPPED
// when it is null (the no-Intel / fresh-store case - api.fpsPoll rejects on
// null via assertValidDeviceId) and the fps line honestly stays '-'.
// M17f: the cadence follows the overlayPollMs slider - ONE module-level
// interval, re-armed by the settings handler when the pushed value changes.
async function resolveOverlayDeviceId(): Promise<number | null> {
  let persisted: { deviceId?: number | null; deviceKey?: string | null } | null = null;
  try {
    persisted = await api.deviceGet();
  } catch {
    return null;
  }
  const fallback = typeof persisted?.deviceId === 'number' && persisted.deviceId >= 0
    ? persisted.deviceId
    : null;
  try {
    const devices = await api.listDevices();
    let preferred: { deviceId?: number | null; deviceKey?: string | null } | null = null;
    try {
      preferred = await api.devicePreferredGet();
    } catch {
      // Keep the persisted-selection fallback when the preference probe is unavailable.
    }
    return resolveBootDevice(
      devices,
      fallback,
      persisted?.deviceKey ?? null,
      preferred?.deviceId ?? null,
      preferred?.deviceKey ?? null,
    );
  } catch {
    return fallback;
  }
}

async function bootFpsLoop(): Promise<void> {
  const bootRequestGeneration = overlayRequestGeneration;
  const resolvedDeviceId = await resolveOverlayDeviceId();
  // A settings/selection refresh may have configured the display lane while
  // the boot preference lookup was pending. Do not let that older read move
  // FPS polling back to a stale numeric device id.
  if (bootRequestGeneration !== overlayRequestGeneration || overlayDisplayDeviceId !== null) {
    armFpsLoop();
    return;
  }
  fpsDeviceId = resolvedDeviceId;
  armFpsLoop();
}

/** M17f: the FPS-poll cadence (ms) - the overlayPollMs slider value; null
 *  until the first settings push -> the renderer's clamp default 400 ms
 *  (M17g: the stock polling rate FLIPS 500 -> 400; clampOverlayPollMs(null)
 *  - the real default, never a hardcoded copy).
 *  The settings handler calls applyFpsPollMs which re-arms the loop. */
let fpsPollMs: number | null = null;
/** The FPS-poll interval id (null = not armed). */
let fpsInterval: number | null = null;
/** The resolved FPS-poll device id (null until bootFpsLoop's device-get
 *  resolves - the arm stays a no-op until then). */
let fpsDeviceId: number | null = null;

/** M17f: (re-)arm the FPS-poll interval with the CURRENT cadence - the
 *  single arm path (boot + every settings push). The loop's interval
 *  callback reads the module-level fpsPollMs at arm time; the handler
 *  re-arms it via clearInterval + setInterval, never a second loop. */
function armFpsLoop(): void {
  if (fpsInterval !== null) {
    window.clearInterval(fpsInterval);
    fpsInterval = null;
  }
  const softwareRendererSelected = overlayRenderer === 'capframex' || softwareRenderer;
  if (!softwareRendererSelected || !overlayEnabled || fpsDeviceId === null) return;
  const pollMs = clampOverlayPollMs(fpsPollMs);
  fpsInterval = window.setInterval(() => {
    void (async () => {
      let sample: FpsSample | null = null;
      try {
        sample = await api.fpsPoll(fpsDeviceId as number);
      } catch {
        sample = null;
      }
      if (!sample) return;
      const fps = typeof sample.fps === 'number' ? sample.fps : null;
      latestFps = fps;
      // M7a: the 1% Low / 99% FPS stats ride the same poll (null when the
      // sample lacks them - the honest '-' on the FPS row).
      latestLow1Pct = typeof sample.low1Pct === 'number' ? sample.low1Pct : null;
      latestP99 = typeof sample.p99 === 'number' ? sample.p99 : null;
      // M12: the window AVG + the 0.1% Low ride the same poll (null when
      // the sample lacks them - the honest '-' on the FPS row).
      latestAvgFps = typeof sample.avgFps === 'number' ? sample.avgFps : null;
      latestLow01Pct = typeof sample.low01Pct === 'number' ? sample.low01Pct : null;
      // M10a/M13: the foreground-window Graphics-API id rides the same
      // poll (null when the sample lacks it - the API row stays empty;
      // the canonical labels are resolved by apiLabelOf in overlayLines).
      latestApi = typeof sample.api === 'string' ? sample.api : null;
      // S1/M2: the frametime series - the real DXGI adapter returns
      // frameTimeMs: null on every path, so deriveFrameTimeMs derives
      // 1000/fps (TWO decimals - M6-amd2: the value line shows max 2
      // decimals; the fps-0 guard keeps Infinity out). The series is
      // trimmed to the ~120-sample window. The series t is in SECONDS
      // (Date.now() / 1000) - the SAME time unit the pure/graph helpers
      // use (their windowS is seconds too; a millisecond t with a 120 s
      // window would trim every point but the newest).
      const ft = deriveFrameTimeMs(fps, sample.frameTimeMs);
      // M6-amd2: the value line tracks the SAME latest derived frame time
      // (null when the poll had nothing -> the honest '-').
      latestFrameTime = ft;
      if (ft !== null) {
        const now = Date.now() / 1000;
        series = trimSeriesWindow(pushSeries(series, now, ft, FRAMETIME_DRAW_POINTS), now, FRAMETIME_WINDOW_S);
        displaySeries = trimSeriesWindow(pushSeries(displaySeries, now, ft, FRAMETIME_DRAW_POINTS), now, FRAMETIME_WINDOW_S);
      }
      render();
    })();
  }, pollMs);
}

/** M17f: re-arm the FPS-poll interval when the pushed overlayPollMs changes
 *  (called from the settings handler - the SAME slider drives the telemetry
 *  push cadence AND the FPS poll). An unchanged value never re-arms (the
 *  duplicate-loop cautionary example - ONE loop, ONE interval). */
function applyFpsPollMs(ms: number): void {
  if (fpsPollMs === ms) return;
  fpsPollMs = ms;
  armFpsLoop();
}

const overlayFpsBoot = bootFpsLoop();

// M17b (2c): the boot NAMES fetch - api.listDevices() + api.sysinfo() ONCE
// (a NEW fetch - the bootFpsLoop deviceGet above is the FPS poll's device
// id, NOT a names fetch). The chip-name labels derive from the SY SINFO
// payload (the plain 'Intel(R) Arc(TM) A770 Graphics' primary video-
// controller name + cpu.name - the mock/real names the cut-down rules
// were pinned against); listDevices is the fallback ONLY when sysinfo has
// no controllers (the real IGCL device name cuts down the same way).
// Never throws: a failed fetch leaves the labels null -> the stock
// 'CPU '/'GPU ' prefixes (the honest degrade).
async function configureOverlayDevices(
  primaryId: number | null,
  devices: OverlayDeviceIdentity[],
  mainSelection: { deviceId?: number | null; deviceKey?: string | null } = {},
  requestGeneration = overlayRequestGeneration,
): Promise<void> {
  if (requestGeneration !== overlayRequestGeneration) return;
  const generation = ++overlayConfigureGeneration;
  const softwareRendererSelected = overlayRenderer === 'capframex' || softwareRenderer;
  const enrichedDevices = await Promise.all(devices.map(async (device) => {
    const known = device.displayActive === true || device.displayActive === false
      || device.osController?.displayActive === true || device.osController?.displayActive === false;
    if (known || !Number.isInteger(device.id) || typeof api.displayGet !== 'function') return device;
    try {
      const state = await api.displayGet(device.id);
      return {
        ...device,
        displayActive: Array.isArray(state?.displays)
          ? state.displays.some((display) => display?.flags?.active === true)
          : null,
      };
    } catch {
      return device;
    }
  }));
  if (requestGeneration !== overlayRequestGeneration || generation !== overlayConfigureGeneration) return;
  const orderedDevices = overlayDeviceOrder(dedupeOverlayDevices(enrichedDevices))
    .map((device, index) => ({ ...device, overlayOrdinal: index + 1 }));
  const selected = overlayDeviceKeys
    ? overlayDeviceOrder(dedupeOverlayDevices(orderedDevices.filter((device) => identityAliases(device).some((key) => overlayDeviceKeys!.some((wanted) => identityToken(wanted) === key)))))
    : orderedDevices;
  // A stale hardware-key list must not blank the HUD after a device swap;
  // degrade to all currently enumerated GPUs until the user selects again.
  const monitored = selected.length > 0 ? selected : orderedDevices;
  const primary = monitored.find((device) => device.displayActive === true || device.osController?.displayActive === true)
    ?? monitored.find((device) => device.id === primaryId)
    ?? monitored[0]
    ?? null;
  // The main telemetry source is independent from the display-driving GPU.
  // Settings refreshes can re-enumerate devices in a different order, so a
  // durable identity wins over the transient numeric id. If the identity is
  // unavailable (legacy/mock inventories), the numeric id is only used as the
  // compatibility fallback; never select by an ordinal.
  const mainSelected = resolveOverlayMainDevice(monitored, orderedDevices, mainSelection, primaryId);
  const resolvedMain = mainSelected ?? primary;
  const mainDeviceId = resolvedMain?.id ?? null;
  const displayDeviceId = primary?.id ?? null;
  const displayDeviceKey = primary ? stableDeviceKey(primary) : null;
  const displayOrdinal = primary?.overlayOrdinal ?? 1;
  const secondary = monitored.filter((device) => device.id !== displayDeviceId);
  const nextSecondaryDeviceIds = secondary.map((device) => device.id);
  const nextSecondaryDeviceOrdinals = secondary.map((device, index) => device.overlayOrdinal ?? index + 2);
  const nextGpuChipLabel = primary
    ? chipLabelForDevice(primary, sysinfoControllersByPnp ?? undefined)
    : null;
  const nextSecondaryGpuChipLabels = distinctGpuLabels(
    nextGpuChipLabel,
    secondary.map((device) => chipLabelForDevice(device, sysinfoControllersByPnp ?? undefined)),
  );
  // Keep the existing main telemetry stream as the display lane whenever
  // possible. Start the display lane here only when the user's selection
  // excludes the main window's device (for example, GPU2-only monitoring).
  const overlayLaneKeys = (mainDeviceId === displayDeviceId
    ? secondary
    : monitored).map((device) => stableDeviceKey(device));
  try {
    await api.overlayTelemetryStart({
      owner: 'overlay',
      deviceKeys: softwareRendererSelected && overlayEnabled ? overlayLaneKeys : [],
    });
  } catch { /* best effort */ }
  if (requestGeneration !== overlayRequestGeneration || generation !== overlayConfigureGeneration) return;
  // Commit the complete candidate only after telemetry startup wins the
  // generation race. This prevents an older, slower request from restoring
  // stale rows, labels, samples, routing, or geometry after a newer request.
  overlayDevices = monitored;
  mainSelectedDevice = resolvedMain;
  mainSelectedDeviceId = resolvedMain?.id ?? null;
  mainSelectedDeviceKey = resolvedMain && (
    (typeof resolvedMain.deviceKey === 'string' && resolvedMain.deviceKey.trim().length > 0)
    || (Array.isArray(resolvedMain.deviceKeys) && resolvedMain.deviceKeys.some((key) => typeof key === 'string' && key.trim().length > 0))
  ) ? stableDeviceKey(resolvedMain) : null;
  overlayDisplayDeviceId = displayDeviceId;
  overlayDisplayDeviceKey = displayDeviceKey;
  overlayDisplayOrdinal = displayOrdinal;
  document.documentElement.dataset.overlayDisplayDevice = String(displayDeviceId ?? '');
  fpsDeviceId = displayDeviceId;
  secondaryDeviceIds = nextSecondaryDeviceIds;
  secondaryDeviceOrdinals = nextSecondaryDeviceOrdinals;
  gpuChipLabel = nextGpuChipLabel;
  secondaryGpuChipLabels = nextSecondaryGpuChipLabels;
  secondarySamples.clear();
  latestSample = null;
  armFpsLoop();
  if (softwareRendererSelected) {
    try { await api.overlayResize(monitored.length); } catch { /* best effort */ }
  }
  if (requestGeneration !== overlayRequestGeneration || generation !== overlayConfigureGeneration) return;
  render();
}
api.onDeviceSelectionUpdated((payload) => {
  if (!payload || !Number.isInteger(payload.deviceId)) return;
  // Cache the main-process selection synchronously, even while RTSS owns the
  // visible HUD. A later switch to the hook-free renderer must use the newest
  // physical GPU, not the last selection committed by this hidden document.
  mainSelectedDeviceId = payload.deviceId;
  mainSelectedDeviceKey = typeof payload.deviceKey === 'string' ? payload.deviceKey : null;
  mainSelectedDevice = null;
  const requestGeneration = ++overlayRequestGeneration;
  if (overlayRenderer !== 'capframex' && !softwareRenderer) return;
  void api.listDevices()
    .then((devices) => {
      const targetId = devices.find((device) => (
        typeof payload.deviceKey === 'string'
        && identityAliases(device).some((key) => key === identityToken(payload.deviceKey))
      ))?.id ?? payload.deviceId;
      return configureOverlayDevices(targetId, devices, {
        deviceId: targetId,
        deviceKey: payload.deviceKey,
      }, requestGeneration);
    })
    .catch(() => { /* keep the last working secondary set */ });
});

async function bootNamesFetch(): Promise<void> {
  // Reserve the boot request before any async inventory or selection read. A
  // live main-device selection received while boot is waiting must supersede
  // this request instead of being invalidated by a later boot generation.
  const requestGeneration = ++overlayRequestGeneration;
  try {
    await overlayFpsBoot;
    let devices: OverlayDeviceIdentity[] = [];
    try { devices = await api.listDevices(); } catch { devices = []; }
    const primaryId = await resolveOverlayDeviceId() ?? devices[0]?.id ?? null;
    let persistedSelection: { deviceId?: number | null; deviceKey?: string | null } = { deviceId: primaryId };
    try {
      const selection = await api.deviceGet();
      persistedSelection = {
        deviceId: typeof selection?.deviceId === 'number' ? selection.deviceId : primaryId,
        deviceKey: typeof selection?.deviceKey === 'string' ? selection.deviceKey : null,
      };
    } catch {
      // The resolved FPS device remains the compatibility fallback.
    }
    await configureOverlayDevices(primaryId, devices, persistedSelection, requestGeneration);
    const sysinfo = await api.sysinfo();
    const controllers: OverlaySysinfoController[] = Array.isArray(sysinfo?.videoControllers)
      ? sysinfo.videoControllers
      : [];
    const controllersByPnp = new Map<string, OverlaySysinfoController[]>();
    for (const controller of controllers) {
      const key = identityToken(controller.pnpDeviceId);
      if (key) controllersByPnp.set(key, [...(controllersByPnp.get(key) ?? []), controller]);
    }
    sysinfoControllersByPnp = controllersByPnp;
    // The listDevices/configure pair can overlap a user selection update while
    // sysinfo is in flight. Cache and project against the CURRENT inventory,
    // never the boot-time array, so a late response cannot leave the selected
    // GPU with a stale decorated name. Identity matching still happens inside
    // controllerForDevice; this does not introduce ordinal fallback.
    for (const device of overlayDevices) {
      const key = deviceIdentity(device);
      const controller = controllerForDevice(device, controllersByPnp);
      if (key && controller) {
        const label = chipLabelGpu(controller.name ?? null);
        if (label) sysinfoGpuLabels.set(key, label);
      }
    }
    const primaryDevice = currentDisplayDevice();
    let primaryLabel: string | null = null;
    if (primaryDevice) {
      const primaryKey = deviceIdentity(primaryDevice);
      const primaryController = controllerForDevice(primaryDevice, controllersByPnp);
      // The mock and older inventory paths expose one primary controller in
      // sysinfo even when the device row has no PNP mirror. With exactly one
      // controller this is unambiguous; multi-GPU sessions require a PNP match
      // and never fall back by ordinal.
      const unambiguousController = primaryController
        ?? (!primaryKey && controllers.length === 1 ? controllers[0] : undefined);
      if (primaryKey && unambiguousController) {
        const label = chipLabelGpu(unambiguousController.name ?? null);
        if (label) sysinfoGpuLabels.set(primaryKey, label);
      }
      const gpuName = unambiguousController?.name ?? primaryDevice.name ?? null;
      primaryLabel = chipLabelGpu(gpuName);
    }
    projectCurrentChipLabels(primaryLabel);
    cpuChipLabel = chipLabelCpu(sysinfo?.cpu?.name ?? null);
    render();
  } catch {
    // The labels stay null and the overlay keeps honest '-' readouts.
  }
}

void bootNamesFetch();
