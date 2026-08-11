// Arc Power - M5/M6 software-overlay model (pure, DOM-free; unit-tested).
//
// The overlay window renders SIX BOLD monospace lines (FPS / CPU / RAM /
// GPU / VRAM / API - the M13 API row joined above the frametime graph)
// plus a frametime polyline. This module owns the line
// formatting + the frametime derivation so the renderer stays thin; every
// function here is unit-tested (the cheap-oracle seam of the milestone).
// The example strings in the plan are ILLUSTRATIVE - the tests pin the
// REAL expected strings.
//
// Field format: one value + its unit per field ('42%', '4.3 GHz', '61°C'),
// '-' for a null field (the unit is dropped with it - the honest degrade,
// never an invented number). Two spaces separate the fields (column
// alignment like the monitor log).
//
// M6: the lines are STATS-AWARE - overlayLines(sample, fps, stats) builds
// each line from the ENABLED stats only (a stat off -> its field vanishes;
// ALL of a line's stats off -> the line writes '' - the renderer KEEPS the
// fixed overlay.html divs and only empties them, never removes them, so the
// getElementById pins + the layout stay intact). The frametime stat is NOT
// a line - it feeds the separate deriveFrameTimeMs + the canvas visibility
// (frametimeEnabled). The percentage formatter ROUNDS to whole percents
// (42.12345678 -> '42%' - the M6 decimals fix; the real OS GPUEngine counter
// is a float and the raw digits used to show in the overlay readout).

import { ghzFreq, gbValue } from './sysinfo.ts';
import type { OverlayPosition } from '../types.ts';

/** The 4 overlay corners (the persisted-truth owner is profile-store.js;
 *  this is the renderer mirror - keep both in lockstep). */
export const OVERLAY_POSITIONS: readonly OverlayPosition[] = [
  'top-left', 'top-right', 'bottom-left', 'bottom-right',
];

/** The Settings-card position labels (one per corner). */
export const OVERLAY_POSITION_LABELS: Record<OverlayPosition, string> = {
  'top-left': 'Top left',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-right': 'Bottom right',
};

/** The scale slider's range (mirrored in ipc-core's clamp). */
export const OVERLAY_SCALE_MIN = 0.5;
export const OVERLAY_SCALE_MAX = 2.0;

/**
 * M6/M7a: the canonical overlay stat ids (the persisted-truth owner is
 * profile-store.js; this is the renderer mirror - keep both in lockstep
 * like the positions). A stat off -> its field/line vanishes; the
 * frametime id is NOT a line - it drives the canvas strip visibility.
 * M7a: 'fps-1pct-low' + 'fps-99pct' ride the FPS row (right after the M12
 * AVG / 0.1% Low pair) - the 1% Low / 99% FPS percentile stats.
 * M10a: 'api' (the foreground-window Graphics-API badge) rides AFTER
 * 'fps-99pct' - the tickbox renders after '99% FPS' while the ROW renders
 * the badge in its OWN standalone line (M13: the api field LEFT the FPS
 * row - the apiLine row sits between the VRAM row and the frametime
 * strip; the row order and the tickbox order are independent - the
 * apiLine content is explicit in overlayLines).
 * M12: 'fps-avg' + 'fps-01pct-low' (the window-AVG / 0.1% Low row stats)
 * ride right after 'fps' (the row field order); 'memory-util' (the Memory
 * row) joins after the CPU stats; 'gpu-vram' stays where it was - it now
 * feeds the standalone VRAM row.
 * M13: 'cpu-power' (the CPU wattage field) joins right after 'cpu-temp'
 * (the row field order - the watt renders after the temp on the CPU row).
 */
export const OVERLAY_STAT_IDS: readonly string[] = [
  'fps', 'fps-avg', 'fps-01pct-low', 'fps-1pct-low', 'fps-99pct', 'api', 'cpu-util', 'cpu-clock', 'cpu-temp', 'cpu-power',
  'memory-util', 'gpu-util', 'gpu-clock', 'gpu-mem-clock', 'gpu-vram',
  'gpu-temp', 'gpu-power', 'gpu-fan', 'frametime',
];

/** M6: the Overlay Settings page's tickbox labels (one per stat id). */
export const OVERLAY_STAT_LABELS: Record<string, string> = {
  fps: 'FPS',
  'fps-avg': 'AVG FPS',
  'fps-01pct-low': '0.1% Low',
  'fps-1pct-low': '1% Low',
  'fps-99pct': '99% FPS',
  api: 'Graphics API',
  'cpu-util': 'CPU Util',
  'cpu-clock': 'CPU Clock',
  'cpu-temp': 'CPU Temp',
  // M13: the CPU wattage stat (the CPU-row watt field after the temp).
  'cpu-power': 'CPU Wattage',
  // M13: the Memory row's label renames to RAM (the stat id stays
  // 'memory-util' - internal, zero churn).
  'memory-util': 'RAM',
  'gpu-util': 'GPU Util',
  'gpu-clock': 'GPU Core clock',
  'gpu-mem-clock': 'GPU Mem clock',
  'gpu-vram': 'VRAM',
  'gpu-temp': 'GPU Temp',
  'gpu-power': 'GPU Wattage',
  'gpu-fan': 'GPU Fan',
  frametime: 'Frametime graph',
};

/** M6: the overlay text color presets (white = the stock color; the custom
 *  hex input accepts any /^#[0-9a-fA-F]{6}$/ value). */
export const OVERLAY_COLOR_PRESETS: readonly string[] = [
  '#ffffff', '#ffe600', '#00ff88', '#00d5ff', '#ff9500', '#ff3b30', '#ff2dd4',
];

/**
 * M7b (fix 4): the overlay BACKGROUND box defaults (the Appearance card's
 * Background section - the persisted-truth owner is profile-store.js; the
 * main-side mirror is overlay.js). The box is black at 0.5 opacity - a
 * translucent box behind the HUD, hidden until overlayBgEnabled.
 */
export const OVERLAY_BG_COLOR_DEFAULT = '#000000';
export const OVERLAY_BG_OPACITY_DEFAULT = 0.5;

/** M7b: clamp the background opacity to 0..1 (garbage degrades to the 0.5
 *  default - the renderer mirror of the store's clamp). */
export function clampOverlayBgOpacity(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : OVERLAY_BG_OPACITY_DEFAULT;
  return Math.min(1, Math.max(0, n));
}

/** M6: the preset swatch labels (one per preset hex). */
export const OVERLAY_COLOR_LABELS: Record<string, string> = {
  '#ffffff': 'White',
  '#ffe600': 'Yellow',
  '#00ff88': 'Green',
  '#00d5ff': 'Cyan',
  '#ff9500': 'Orange',
  '#ff3b30': 'Red',
  '#ff2dd4': 'Magenta',
};

export function isValidOverlayPosition(v: unknown): v is OverlayPosition {
  return typeof v === 'string' && (OVERLAY_POSITIONS as readonly string[]).includes(v);
}

/** M6: whether v is one of the canonical overlay stat ids. */
export function isValidOverlayStat(v: unknown): v is string {
  return typeof v === 'string' && (OVERLAY_STAT_IDS as readonly string[]).includes(v);
}

/** M10a: the canonical Graphics-API field labels (the ONLY strings the api
 *  field may ever show - 'DX12' / 'Vulkan' / 'DX11' / 'DX10' / 'DX9' /
 *  'OpenGL'; the ids are the detector contract of src/main/foreground-api.js;
 *  M10b added 'dx9' - the League-of-Legends (DirectX 9) detection; M12 added
 *  'dx10' - the DirectX-10 detection completeness). */
export const OVERLAY_API_LABELS: Record<string, string> = {
  dx12: 'DX12',
  vulkan: 'Vulkan',
  dx11: 'DX11',
  dx10: 'DX10',
  dx9: 'DX9',
  opengl: 'OpenGL',
};

/** M10a: the display label for a detected api id - null for null/unknown
 *  (the API row stays EMPTY - never '-', never a raw id). */
export function apiLabelOf(v: unknown): string | null {
  return typeof v === 'string' ? (OVERLAY_API_LABELS[v] ?? null) : null;
}

/**
 * M6: normalize a raw overlayStats value - an array of KNOWN ids, deduped
 * (order preserved); absent/garbage -> the FULL set (the default - the
 * stock overlay shows everything). The renderer mirror of the main-side
 * normalize (profile-store.js owns the persisted truth).
 */
export function normalizeOverlayStats(v: unknown): string[] {
  if (!Array.isArray(v)) return [...OVERLAY_STAT_IDS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of v) {
    if (isValidOverlayStat(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** M6: whether v is a valid 6-digit hex color (the ipc-core + store
 *  validation mirror; the type=color input always yields this shape). */
export function isValidOverlayColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}

/** Clamp a scale value to 0.5..2.0 (garbage degrades to 1.0 - the default). */
export function clampOverlayScale(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 1;
  return Math.min(OVERLAY_SCALE_MAX, Math.max(OVERLAY_SCALE_MIN, n));
}

/** The telemetry fields the overlay lines read (a subset of TelemetrySample). */
export interface OverlaySample {
  utilPct?: number | null;
  /** M4-I: the OS GPU-utilization counter - the fallback when the device
   *  utilPct is absent (the no-Intel shape). */
  gpuUtilPct?: number | null;
  gpuClockMhz?: number | null;
  memClockMhz?: number | null;
  gpuMemUsedBytes?: number | null;
  tempC?: number | null;
  powerW?: number | null;
  fanRpm?: number[] | null;
  cpuUtilPct?: number | null;
  cpuFreqMhz?: number | null;
  cpuTempC?: number | null;
  /** M13: the CPU package wattage (watts - the PowerMeter / MSR RAPL
   *  source, already carried by the telemetry; the CPU-row watt field
   *  after the temp, toFixed(1) - the GPU watt format). */
  cpuPowerW?: number | null;
  /** M14: the system-wide USED RAM in bytes (GlobalMemoryStatusEx ->
   *  ullTotalPhys - ullAvailPhys - the Memory row's source; the explicit
   *  memoryUsedBytes parameter wins when both are present). The M12
   *  memoryUtilPct percent field is REPLACED by this. */
  memoryUsedBytes?: number | null;
}

export interface OverlayLines {
  fpsLine: string;
  cpuLine: string;
  /** M12: the Memory row (the memory-util stat; '' when the stat is off).
   *  M13: the row label reads 'RAM'. */
  memoryLine: string;
  gpuLine: string;
  /** M12: the VRAM row (the gpu-vram stat - the field LEFT the GPU row and
   *  now feeds this standalone row; '' when the stat is off). */
  vramLine: string;
  /** M13: the standalone Graphics-API row (the api field LEFT the fpsLine
   *  and now feeds this row between the VRAM row and the frametime strip).
   *  'DX12' or '' - the M10a vanish rule: EMPTY when the api is
   *  null/unknown or the api stat is off, never a '-'. */
  apiLine: string;
  /** M6: the frametime stat is enabled - the stat is NOT a line, it feeds
   *  the canvas strip; the renderer shows/hides the strip by this flag. */
  frametimeEnabled: boolean;
}

/** A finite number or null (the honest degrade for every field). */
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** One field: '42%' / '4.3 GHz' / '-'. Null drops the unit with the value. */
function unit(v: number | null, fmt: (n: number) => string, suffix: string): string {
  return v === null ? '-' : `${fmt(v)}${suffix}`;
}

/**
 * Build the overlay lines from one telemetry sample + the latest FPS (the
 * 1 s fps-poll result) + the ENABLED stats (M6 - an absent stats value
 * means the FULL set, the stock overlay) + the latest percentile stats
 * (M7a/M12 - the low1Pct / low01Pct / avgFps / p99 numbers from the same
 * fps poll, null until the sampler's frame floors) + the api id + the RAM
 * utilization. Every enabled field degrades honestly to '-':
 *   fpsLine: 'FPS 60  AVG 58  1% Low 52  0.1% Low 40  99% FPS 58' - the
 *     FPS field rounds like the Monitoring tile and renders 'FPS -' for
 *     null, non-finite or <= 0 fps (0 is the DXGI no-signal shape - not a
 *     real frame rate); the AVG / 1% Low / 0.1% Low / 99% FPS fields
 *     render '-' when their numbers are null (the honest degrade - never
 *     a stale value); each field vanishes with its stat; '' when all five
 *     are off (M13: the api field LEFT this row - the six FPS-row stats
 *     became five);
 *   cpuLine: 'CPU 42%  4.3 GHz  61°C  125.5 W' (Util / Clock via ghzFreq /
 *     Temp / Wattage with ONE decimal (toFixed(1) - the GPU watt format;
 *     M13) - each field vanishes with its stat; '' when all four are off);
 *   memoryLine: 'RAM 12.4 GB' (M14 - the system-wide USED RAM in bytes
 *     via gbValue (decimal GB, one decimal - the VRAM row's format; the
 *     M12 memoryUtilPct percent is REPLACED); M13: the row label reads
 *     'RAM' - the stat id stays 'memory-util'; '' when the memory-util
 *     stat is off);
 *   gpuLine: 'GPU 42%  2500 MHz  2187 MHz  65°C  122 W  1030 RPM' (Util /
 *     Core clock / Memory clock / Temp / Power with ONE decimal (toFixed(1)
 *     - 38.8) / Fan (first RPM of the array) - each field vanishes with its
 *     stat; '' when all six are off; M12: the VRAM field LEFT this row);
 *   vramLine: 'VRAM 8.5 GB' (M12 - the gpu-vram stat via gbValue; '' when
 *     the stat is off);
 *   apiLine: 'DX12' (M13 - the standalone Graphics-API row; the api field
 *     LEFT the fpsLine and now renders its own row between the VRAM row
 *     and the frametime strip. EMPTY when the api is null/unknown or the
 *     api stat is off - "if it's none, it won't display anything", never
 *     a '-'; only the canonical labels ever render (apiLabelOf)).
 * M7a (fix 3): the 'CPU '/'GPU ' row label is NOT baked into any field -
 * it is prefixed ONCE to the first field when the row is non-empty
 * ('CPU 61°C' for a temp-only row - never a bare '61°C'; the stock rows
 * keep their exact strings). The Memory / VRAM labels ride the same rule.
 * M13 (the M2 explicit move): the api parameter (the foreground-window
 * Graphics-API badge) feeds the STANDALONE apiLine - the fpsLine carries
 * no api field anymore.
 */
export function overlayLines(sample: OverlaySample | null | undefined, fps: number | null | undefined, stats?: unknown, low1Pct?: number | null, p99?: number | null, api?: string | null, avgFps?: number | null, low01Pct?: number | null, memoryUsedBytes?: number | null): OverlayLines {
  const s = sample ?? {};
  // M6: the percentage formatter ROUNDS to whole percents (
  // decimals complaint - the real OS GPUEngine counter is a float
  // 42.12345678... and the raw digits used to show in the overlay; the
  // mock emits 42 so the old pins never caught it).
  const pct = (v: number | null): string => (v === null ? '-' : `${Math.round(v)}%`);
  const enabled = new Set(normalizeOverlayStats(stats));
  const cpuUtil = numOrNull(s.cpuUtilPct);
  const cpuFreqMhz = numOrNull(s.cpuFreqMhz);
  const cpuTemp = numOrNull(s.cpuTempC);
  const cpuPower = numOrNull(s.cpuPowerW);
  // The device utilPct wins; the OS counter is the fallback (both null -> '-').
  const gpuUtil = numOrNull(s.utilPct) ?? numOrNull(s.gpuUtilPct);
  const gpuClock = numOrNull(s.gpuClockMhz);
  const memClock = numOrNull(s.memClockMhz);
  const vram = numOrNull(s.gpuMemUsedBytes);
  const gpuTemp = numOrNull(s.tempC);
  const power = numOrNull(s.powerW);
  const fan = Array.isArray(s.fanRpm) ? numOrNull(s.fanRpm[0]) : null;
  const fpsNum = numOrNull(fps);
  const avg = numOrNull(avgFps);
  const low1 = numOrNull(low1Pct);
  const low01 = numOrNull(low01Pct);
  const p99num = numOrNull(p99);
  // M14: the explicit memoryUsedBytes parameter wins; the sample's field
  // is the fallback (the renderer passes the telemetry field explicitly).
  const memoryUsed = numOrNull(memoryUsedBytes ?? s.memoryUsedBytes);
  // M7a/M12: the FPS row builds from its FIVE enabled stats in fixed
  // order - 'FPS <round>' + ' AVG <round>' + ' 1% Low <round>' +
  // ' 0.1% Low <round>' + ' 99% FPS <round>' (each field carries its
  // leading two-space separator, exactly like the plan pins; the FPS field
  // leads the row - M13: the api badge LEFT this row and renders its own
  // standalone apiLine below). The numeric fields round to whole numbers
  // and render '-' when null (the sampler's honest degrade before its
  // frame floors). All five off -> ''.
  let fpsLine = '';
  if (enabled.has('fps')) {
    const fpsField = fpsNum !== null && fpsNum > 0 ? `FPS ${Math.round(fpsNum)}` : 'FPS -';
    fpsLine += fpsLine === '' ? fpsField : `  ${fpsField}`;
  }
  if (enabled.has('fps-avg')) fpsLine += `  AVG ${avg === null ? '-' : Math.round(avg)}`;
  if (enabled.has('fps-1pct-low')) fpsLine += `  1% Low ${low1 === null ? '-' : Math.round(low1)}`;
  if (enabled.has('fps-01pct-low')) fpsLine += `  0.1% Low ${low01 === null ? '-' : Math.round(low01)}`;
  if (enabled.has('fps-99pct')) fpsLine += `  99% FPS ${p99num === null ? '-' : Math.round(p99num)}`;
  // M13: the standalone Graphics-API row - the api field LEFT the fpsLine.
  // 'DX12' or '' - the M10a vanish rule: EMPTY when the api is
  // null/unknown ( "if it's none, it won't display anything" - never a
  // '-', never a raw id) and when the api stat is off.
  const apiLine = enabled.has('api') ? (apiLabelOf(api) ?? '') : '';
  // M6: each line builds from its ENABLED stats only - a stat off -> its
  // field vanishes; ALL of a line's stats off -> the line writes '' (the
  // renderer KEEPS the fixed div and only empties it - never removed).
  // M7a (fix 3): the fields carry NO baked 'CPU '/'GPU ' prefix - the row
  // label prefixes the FIRST field once when the row is non-empty (the
  // label can never ride away with the util stat again).
  const cpuFields: string[] = [];
  if (enabled.has('cpu-util')) cpuFields.push(pct(cpuUtil));
  if (enabled.has('cpu-clock')) cpuFields.push(unit(cpuFreqMhz, (n) => ghzFreq(n), ' GHz'));
  if (enabled.has('cpu-temp')) cpuFields.push(unit(cpuTemp, (n) => String(n), '°C'));
  // M13: the CPU wattage - after the temp, toFixed(1) (the GPU watt format).
  if (enabled.has('cpu-power')) cpuFields.push(unit(cpuPower, (n) => n.toFixed(1), ' W'));
  const cpuLine = cpuFields.length === 0 ? '' : `CPU ${cpuFields.join('  ')}`;
  // M14: the Memory row - the memory-util stat only ('RAM 12.4 GB' - the
  // M13 row label + the gbValue decimal-GB format; the honest '-' when
  // the field is null); '' when the stat is off.
  const memoryLine = enabled.has('memory-util') ? `RAM ${unit(memoryUsed, (n) => gbValue(n), ' GB')}` : '';
  const gpuFields: string[] = [];
  if (enabled.has('gpu-util')) gpuFields.push(pct(gpuUtil));
  if (enabled.has('gpu-clock')) gpuFields.push(unit(gpuClock, (n) => String(n), ' MHz'));
  if (enabled.has('gpu-mem-clock')) gpuFields.push(unit(memClock, (n) => String(n), ' MHz'));
  if (enabled.has('gpu-temp')) gpuFields.push(unit(gpuTemp, (n) => String(n), '°C'));
  if (enabled.has('gpu-power')) gpuFields.push(unit(power, (n) => n.toFixed(1), ' W'));
  if (enabled.has('gpu-fan')) gpuFields.push(unit(fan, (n) => String(n), ' RPM'));
  const gpuLine = gpuFields.length === 0 ? '' : `GPU ${gpuFields.join('  ')}`;
  // M12: the VRAM row - the gpu-vram stat (the field LEFT the GPU row and
  // now feeds this standalone row below it); '' when the stat is off.
  const vramLine = enabled.has('gpu-vram') ? `VRAM ${unit(vram, (n) => gbValue(n), ' GB')}` : '';
  return { fpsLine, cpuLine, memoryLine, gpuLine, vramLine, apiLine, frametimeEnabled: enabled.has('frametime') };
}

/**
 * The frametime value for the polyline series. Passthrough when frameTimeMs
 * is a finite number > 0 (the RID_MOCK_FPS=1 16.7 ms shape); else 1000 / fps
 * when fps is a finite number > 0, rounded to TWO decimals (1000/60 =
 * 16.666.. -> 16.67 - M6-amd2: the frametime NUMBER shows max 2 decimals;
 * the pre-amendment ONE-decimal rounding (16.7) moved to the format step);
 * else null (nothing drawn). The fps-0 guard: the real DXGI adapter returns
 * fps: 0 on its no-signal paths, and 1000/0 = Infinity would poison the
 * series + the canvas scaling - it must never enter.
 */
export function deriveFrameTimeMs(fps: number | null | undefined, frameTimeMs: number | null | undefined): number | null {
  if (typeof frameTimeMs === 'number' && Number.isFinite(frameTimeMs) && frameTimeMs > 0) {
    return frameTimeMs;
  }
  if (typeof fps === 'number' && Number.isFinite(fps) && fps > 0) {
    return Math.round((1000 / fps) * 100) / 100;
  }
  return null;
}

/**
 * M6-amd2: format a derived frame time for the overlay's value line -
 * MAXIMUM 2 decimals, NEVER padded ('16.67 ms', '16.7 ms' - never
 * '16.70 ms'; the passthrough 16.7 stays '16.7 ms'). Honest '-' when
 * there is no data (null / non-finite / <= 0 - the fps-0 guard shape).
 */
export function formatFrametime(ft: number | null | undefined): string {
  if (typeof ft !== 'number' || !Number.isFinite(ft) || ft <= 0) return '-';
  return `${Math.round(ft * 100) / 100} ms`;
}
