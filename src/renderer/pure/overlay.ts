// Arc Power - M5/M6 software-overlay model (pure, DOM-free; unit-tested).
//
// The overlay window renders SIX BOLD monospace lines (FPS / CPU / RAM /
// GPU / VRAM / API - the M13 API row joined above the frametime graph)
// plus a frametime polyline. This module owns the line
// formatting + the frametime derivation so the renderer stays thin; every
// function here is unit-tested (the cheap-oracle seam of the milestone).
// The example strings in the plan are ILLUSTRATIVE - the tests pin the
// REAL expected strings. M16 (amended 2026-08-11): the GPU VOLTAGE is a
// FIELD INSIDE the GPU row (between the temp and the power fields) - the
// standalone Voltage row is gone, the overlay is back to the SIX lines.
//
// Field format: one value + its GLUED unit per field ('42%', '4.3GHz',
// '61°C' - M18: the unit never carries a leading space, the value and the
// unit are one token), '-' for a null field (the unit is dropped with it -
// the honest degrade, never an invented number). Two spaces separate the
// fields (column alignment like the monitor log).
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

/** M24: the overlay THEME ids - the persisted-truth owner is
 *  profile-store.js; this is the renderer mirror (keep both in lockstep).
 *  'classic' is the original RTSS-style HUD; 'arc' is the redesigned
 *  Intel-Arc-tinted harness (the PRODUCT default - the redesign IS the
 *  product; 'classic' stays one click away via the Overlay Settings Theme
 *  row). Absent/garbage -> 'arc' (the store's absent-field default). */
export const OVERLAY_THEMES: readonly string[] = ['classic', 'arc'];
/** M24: the product-default overlay theme ('arc' - the redesign; the
 *  persisted-truth owner is profile-store.js, keep both in lockstep). */
export const OVERLAY_THEME_DEFAULT = 'arc';

/** M24: whether v is one of the two overlay theme ids. */
export function isValidOverlayTheme(v: unknown): v is 'classic' | 'arc' {
  return typeof v === 'string' && (OVERLAY_THEMES as readonly string[]).includes(v);
}

/** M23: the ADVANCED overlay's anchored-edge ids (the persisted-truth owner
 *  is profile-store.js - the HUD's lockstep family; this mirror joins the
 *  same module. Keep both in lockstep). The panel anchors to the PRIMARY
 *  display's left or right edge (Adrenaline opens on the right). */
export const ADVANCED_OVERLAY_POSITIONS: readonly string[] = ['left', 'right'];

/** The advanced-overlay position select labels. */
export const ADVANCED_OVERLAY_POSITION_LABELS: Record<string, string> = {
  left: 'Left edge',
  right: 'Right edge',
};

/** M23: whether v is one of the advanced-overlay anchored-edge ids. */
export function isValidAdvancedOverlayPosition(v: unknown): v is 'left' | 'right' {
  return typeof v === 'string' && (ADVANCED_OVERLAY_POSITIONS as readonly string[]).includes(v);
}

/** The scale slider's range (mirrored in ipc-core's clamp). */
export const OVERLAY_SCALE_MIN = 0.5;
export const OVERLAY_SCALE_MAX = 2.0;

/** M17e: the overlay polling-rate slider's range + default (the
 *  telemetry-service default; mirrored in profile-store.js + ipc-core.js -
 *  keep the three in lockstep). M17g: the DEFAULT FLIPS 500 -> 400 (the
 *  user's stock polling rate). */
export const OVERLAY_POLL_MS_MIN = 100;
export const OVERLAY_POLL_MS_MAX = 2000;
export const OVERLAY_POLL_MS_DEFAULT = 400;

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
 * apiLine content is explicit in overlayLines). M19b: the apiLine row
 * carries the 'API' row label like the other five rows - the SIXTH
 * labeled row of the divider column).
 * M12: 'fps-avg' + 'fps-01pct-low' (the window-AVG / 0.1% Low row stats)
 * ride right after 'fps' (the row field order); 'memory-util' (the Memory
 * row) joins after the CPU stats; 'gpu-vram' stays where it was - it now
 * feeds the standalone VRAM row.
 * M13: 'cpu-power' (the CPU wattage field) joins right after 'cpu-temp'
 * (the row field order - the watt renders after the temp on the CPU row).
 * M16: 'gpu-voltage' (the GPU-row voltage field - the amended shape has NO
 * standalone Voltage row: the field renders INSIDE the GPU row between the
 * temp and the power fields) joins after 'gpu-clock'; 'gpu-vram-temp' (the
 * VRAM row's trailing field) closes the GPU stats.
 */
// M25: reordered by category for compactness: CPU / RAM / GPU / VRAM / FPS / API.
export const OVERLAY_STAT_IDS: readonly string[] = [
  'cpu-util', 'cpu-clock', 'cpu-temp', 'cpu-power',
  'memory-util',
  'gpu-util', 'gpu-clock', 'gpu-voltage', 'gpu-temp', 'gpu-power', 'gpu-fan',
  'gpu-mem-clock', 'gpu-vram', 'gpu-vram-temp',
  'fps', 'fps-avg', 'fps-01pct-low', 'fps-1pct-low', 'fps-99pct',
  'api', 'frametime',
];

/** M17g (the user's stock overlay settings): the DEFAULT overlayStats set -
 *  the user's 11 ON (fps, api, cpu-util, cpu-temp, cpu-power, memory-util,
 *  gpu-util, gpu-temp, gpu-power, gpu-vram, frametime) / the OTHERS OFF.
 *  The renderer mirror of the store's OVERLAY_STATS_DEFAULT (the
 *  persisted-truth owner is profile-store.js - keep both in lockstep);
 *  absent/garbage overlayStats degrades to this set (the M6 full-set
 *  default FLIPS). */
// M25: reordered by category (CPU / RAM / GPU / VRAM / FPS / API).
export const OVERLAY_STATS_DEFAULT: readonly string[] = [
  'cpu-util', 'cpu-temp', 'cpu-power',
  'memory-util',
  'gpu-util', 'gpu-temp', 'gpu-power', 'gpu-vram',
  'fps', 'api', 'frametime',
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
  // M16: the GPU voltage stat - a FIELD INSIDE the GPU row (between the
  // temp and the power fields - the amended shape; the standalone Voltage
  // row is gone). This is the tickbox label.
  'gpu-voltage': 'GPU Voltage',
  'gpu-temp': 'GPU Temp',
  'gpu-power': 'GPU Wattage',
  'gpu-fan': 'GPU Fan',
  // M16: the mem-clock stat LEFT the GPU row - it now leads the VRAM row
  // ('MemClock;VRAM;VramTEMP' - the user's requested order).
  'gpu-mem-clock': 'Mem clock',
  'gpu-vram': 'VRAM',
  'gpu-vram-temp': 'VRAM temp',
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

/** M17e: clamp the overlay polling-rate to the slider's 100-2000 ms range
 *  (garbage degrades to the 400 ms default - M17g: the default FLIPS 500 ->
 *  400; the renderer mirror of the store/ipc-core clamps - a garbage
 *  overlayPollMs must degrade to 400 in BOTH the store and the renderer,
 *  never a 500/400 split). */
export function clampOverlayPollMs(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : OVERLAY_POLL_MS_DEFAULT;
  return Math.min(OVERLAY_POLL_MS_MAX, Math.max(OVERLAY_POLL_MS_MIN, Math.round(n)));
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
 *  'dx10' - the DirectX-10 detection completeness).
 *  M17d (Run C, item 1e): the PresentMon-service CLASS corroboration ids -
 *  'dxgi' / 'd3d9' / 'other' (the fps-pm lane's presentRuntime field - the
 *  PM_GRAPHICS_RUNTIME class: DXGI/D3D9/Other). The badge logic is
 *  UNCHANGED: the class rides the SAME sample field the overlay already
 *  renders (apiLabelOf - the fps-poll composes it only when the module scan
 *  yields null); the FINE grain (dx11-vs-dx12, Vulkan-vs-OGL) stays
 *  module-derived (PresentMon's runtime class cannot distinguish them). */
export const OVERLAY_API_LABELS: Record<string, string> = {
  dx12: 'DX12',
  vulkan: 'Vulkan',
  dx11: 'DX11',
  dx10: 'DX10',
  dx9: 'DX9',
  opengl: 'OpenGL',
  dxgi: 'DXGI',
  d3d9: 'D3D9',
  other: 'Other',
};

/** M10a: the display label for a detected api id - null for null/unknown
 *  (the API row stays EMPTY - never '-', never a raw id). */
export function apiLabelOf(v: unknown): string | null {
  return typeof v === 'string' ? (OVERLAY_API_LABELS[v] ?? null) : null;
}

/**
 * M6: normalize a raw overlayStats value - an array of KNOWN ids, deduped
 * (order preserved); absent/garbage -> the DEFAULT set (M17g: the user's
 * 11 ON / the others OFF - the M6 full-set default FLIPS; the stock
 * overlay now shows the user's set). The renderer mirror of the main-side
 * normalize (profile-store.js owns the persisted truth).
 * M16 (B1): this mirror deliberately does NOT union the ids the canonical
 * list gained in M16 onto a trimmed array - the overlay renders whatever
 * stats main pushes, and a save-side union would resurrect a stat the user
 * just unchecked. The one-time upgrade of PERSISTED lists (the M15 ->
 * M16 migration) lives in the store's v2 -> v3 schema migration.
 */
export function normalizeOverlayStats(v: unknown): string[] {
  if (!Array.isArray(v)) return [...OVERLAY_STATS_DEFAULT];
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
  /** M16: the GPU voltage (volts - the GPU-row voltage field's source
   *  between the temp and the power fields; the mock emits 0.652, the real
   *  backend reads gpuVoltage telemetry). */
  gpuVoltageV?: number | null;
  /** M16: the VRAM temperature (°C - the VRAM row's trailing field; the
   *  mock emits tempCBase + 8, the real backend reads vramCurrentTemp). */
  vramTempC?: number | null;
}

export interface OverlayLines {
  fpsLine: string;
  cpuLine: string;
  /** M12: the Memory row (the memory-util stat; '' when the stat is off).
   *  M13: the row label reads 'RAM'. */
  memoryLine: string;
  gpuLine: string;
  /** M12: the VRAM row (the gpu-vram stat - the field LEFT the GPU row and
   *  now feeds this standalone row; '' when the stat is off). M16: the
   *  mem-clock field LEFT the GPU row too and LEADS this row, followed by
   *  the VRAM usage + the VRAM temperature ('MemClock;VRAM;VramTEMP' - the
   *  user's requested order). */
  vramLine: string;
  /** M13: the standalone Graphics-API row (the api field LEFT the fpsLine
   *  and now feeds this row between the VRAM row and the frametime strip).
   *  'API   DX12' or '' - the M10a vanish rule: EMPTY when the api is
   *  null/unknown or the api stat is off, never a '-'. */
  apiLine: string;
  /** M18/M19b: the SIX labeled-row labels (the header-divider column
   *  source). The cpu/gpu entries carry the M17b chip-name labels when
   *  enabled, the stock prefixes otherwise (the same cpuPrefix/gpuPrefix
   *  the lines render); fps/memory/vram are the fixed 'FPS' / 'RAM' /
   *  'VRAM'; the M19b api entry is the fixed 'API' - the API row joined
   *  the divider column as the SIXTH labeled row. The renderer measures
   *  the max label length from these and sets the --overlay-label-w CSS
   *  var (in ch) per render. */
  labels: { fps: string; cpu: string; memory: string; gpu: string; vram: string; api: string };
  /** M6: the frametime stat is enabled - the stat is NOT a line, it feeds
   *  the canvas strip; the renderer shows/hides the strip by this flag. */
  frametimeEnabled: boolean;
}

/** A finite number or null (the honest degrade for every field). */
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** One field: '42%' / '4.3GHz' / '-'. Null drops the unit with the value. */
function unit(v: number | null, fmt: (n: number) => string, suffix: string): string {
  return v === null ? '-' : `${fmt(v)}${suffix}`;
}

/**
 * Build the overlay lines from one telemetry sample + the latest FPS (the
 * 1 s fps-poll result) + the ENABLED stats (M6 - an absent stats value
 * means the DEFAULT set - M17g: the user's 11 ON / the others OFF, the M6
 * full-set default FLIPS) + the latest percentile stats
 * (M7a/M12 - the low1Pct / low01Pct / avgFps / p99 numbers from the same
 * fps poll, null until the sampler's frame floors) + the api id + the RAM
 * utilization. Every enabled field degrades honestly to '-':
 *   fpsLine: 'FPS   60  AVG 58  1% Low 52  0.1% Low 40  99% FPS 58' - the
 *     FPS field rounds like the Monitoring tile and renders 'FPS   -' for
 *     null, non-finite or <= 0 fps (0 is the DXGI no-signal shape - not a
 *     real frame rate); the AVG / 1% Low / 0.1% Low / 99% FPS fields
 *     render '-' when their numbers are null (the honest degrade - never
 *     a stale value); each field vanishes with its stat; '' when all five
 *     are off (M13: the api field LEFT this row - the six FPS-row stats
 *     became five);
 *   cpuLine: 'CPU   42%  4.3GHz  61°C  125.5W' (Util / Clock via ghzFreq /
 *     Temp / Wattage with ONE decimal (toFixed(1) - the GPU watt format;
 *     M13) - each field vanishes with its stat; '' when all four are off);
 *   memoryLine: 'RAM   12.4GB' (M14 - the system-wide USED RAM in bytes
 *     via gbValue (decimal GB, one decimal - the VRAM row's format; the
 *     M12 memoryUtilPct percent is REPLACED); M13: the row label reads
 *     'RAM' - the stat id stays 'memory-util'; '' when the memory-util
 *     stat is off);
 *   gpuLine: 'GPU   42%  2500MHz  65°C  0.652V  38.8W  1030RPM'
 *     (Util / Core clock / Temp / Voltage (volts with 3 decimals - M16,
 *     the amended shape: the voltage field rides INSIDE the GPU row
 *     between the temp and the power fields) / Power with ONE decimal
 *     (toFixed(1) - 38.8) / Fan (first RPM of the array) - each field
 *     vanishes with its stat; '' when all six are off; M16: the MEM-CLOCK
 *     field LEFT this row - it leads the VRAM row now);
 *   vramLine: 'VRAM  2187MHz  3.0GB  73°C' (M16 - the mem-clock field
 *     LEADS (gpu-mem-clock), then the VRAM usage (gpu-vram via gbValue),
 *     then the VRAM temperature (gpu-vram-temp); '' when ALL three stats
 *     are off);
 *   apiLine: 'API   DX12' (M13: the standalone Graphics-API row; the api
 *     field LEFT the fpsLine and now renders its own row between the VRAM
 *     row and the frametime strip. EMPTY when the api is null/unknown or
 *     the api stat is off - "if it's none, it won't display anything",
 *     never a '-'; only the canonical labels ever render (apiLabelOf)).
 *     M19b: the row rides the SAME labeledRow rule - the 'API' label
 *     padded to the max label length + the two-space separator ('API   '
 *     at the stock 4ch column, 'API        ' under the M17b 9ch chip
 *     column), so its value aligns with the other five rows.
 * M7a (fix 3): the 'CPU '/'GPU ' row label is NOT baked into any field -
 * it is prefixed ONCE to the first field when the row is non-empty
 * ('CPU   61°C' for a temp-only row - never a bare '61°C') and padded to
 * the max label length (M19b: label.padEnd(maxLabelLen) + '  ' - the
 * two-space separator; the already-4-ch 'VRAM' label only gains the
 * separator - 'VRAM  '; the shorter labels pad - 'FPS   ' / 'CPU   ' /
 * 'RAM   ' / 'GPU   '). M19b: the separator FLIPS to TWO spaces -
 * `label.padEnd(maxLabelLen) + '  ' + fields` - every value starts at
 * maxLabelLen + 2 ch (the divider-to-value gap).
 * The Memory / VRAM labels ride the same rule.
 * M13 (the M2 explicit move): the api parameter (the foreground-window
 * Graphics-API badge) feeds the STANDALONE apiLine - the fpsLine carries
 * no api field anymore.
 * M17b (2c): the optional opts parameter carries the chip-name row labels
 * ({ chipLabels: { cpu, gpu } } - the pure chip-label cut-downs from the
 * renderer's boot names fetch). A non-empty label REPLACES the stock
 * 'CPU '/'GPU ' prefix ONLY (the field order is untouched - the label is
 * the row prefix, never a field); absent/empty -> the stock prefixes (all
 * existing pins stay green).
 */
export interface OverlayLinesOpts {
  /** M17b: the chip-name row labels (null/absent -> the stock prefixes). */
  chipLabels?: { cpu?: string | null; gpu?: string | null };
}

export function overlayLines(sample: OverlaySample | null | undefined, fps: number | null | undefined, stats?: unknown, low1Pct?: number | null, p99?: number | null, api?: string | null, avgFps?: number | null, low01Pct?: number | null, memoryUsedBytes?: number | null, opts?: OverlayLinesOpts): OverlayLines {
  const s = sample ?? {};
  // M17b (2c): the chip-name row labels - a non-empty label replaces the
  // stock prefix (the renderer passes them when the overlayChipNames
  // setting is on); absent/empty -> 'CPU '/'GPU ' (the stock rows).
  const cpuPrefix = typeof opts?.chipLabels?.cpu === 'string' && opts.chipLabels.cpu.length > 0 ? opts.chipLabels.cpu : 'CPU';
  const gpuPrefix = typeof opts?.chipLabels?.gpu === 'string' && opts.chipLabels.gpu.length > 0 ? opts.chipLabels.gpu : 'GPU';
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
  const vramTemp = numOrNull(s.vramTempC);
  const gpuVoltage = numOrNull(s.gpuVoltageV);
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
  // order - the first field is the bare frame rate, then ' AVG <round>' +
  // ' 1% Low <round>' + ' 0.1% Low <round>' + ' 99% FPS <round>' (each
  // field carries its leading two-space separator, exactly like the plan
  // pins; M13: the api badge LEFT this row and renders its own standalone
  // apiLine below). The numeric fields round to whole numbers and render
  // '-' when null (the sampler's honest degrade before its frame floors).
  // M19: the 'FPS' row label is NO LONGER baked into the first field -
  // the row assembles through the padded-label rule below, so the FPS row
  // follows the SAME label-once rule as the CPU/GPU rows (a row with the
  // fps stat off but a percentile stat on still shows the 'FPS' header -
  // the M7a fix-3 shape, uniformly applied). All five off -> ''.
  const fpsFields: string[] = [];
  if (enabled.has('fps')) {
    fpsFields.push(fpsNum !== null && fpsNum > 0 ? `${Math.round(fpsNum)}` : '-');
  }
  if (enabled.has('fps-avg')) fpsFields.push(`AVG ${avg === null ? '-' : Math.round(avg)}`);
  if (enabled.has('fps-1pct-low')) fpsFields.push(`1% Low ${low1 === null ? '-' : Math.round(low1)}`);
  if (enabled.has('fps-01pct-low')) fpsFields.push(`0.1% Low ${low01 === null ? '-' : Math.round(low01)}`);
  if (enabled.has('fps-99pct')) fpsFields.push(`99% FPS ${p99num === null ? '-' : Math.round(p99num)}`);
  // M6: each line builds from its ENABLED stats only - a stat off -> its
  // field vanishes; ALL of a line's stats off -> the line writes '' (the
  // renderer KEEPS the fixed div and only empties it - never removed).
  // M7a (fix 3): the fields carry NO baked 'CPU '/'GPU ' prefix - the row
  // label prefixes the FIRST field once when the row is non-empty (the
  // label can never ride away with the util stat again).
  const cpuFields: string[] = [];
  if (enabled.has('cpu-util')) cpuFields.push(pct(cpuUtil));
  if (enabled.has('cpu-clock')) cpuFields.push(unit(cpuFreqMhz, (n) => ghzFreq(n), 'GHz'));
  // M17b: the temp fields round to whole degrees (Math.round - the AMD
  // SMN die temp is 0.125 °C/LSB, so 60.5 renders '61°C', never '60.5°C').
  if (enabled.has('cpu-temp')) cpuFields.push(unit(cpuTemp, (n) => String(Math.round(n)), '°C'));
  // M13: the CPU wattage - after the temp, toFixed(1) (the GPU watt format).
  if (enabled.has('cpu-power')) cpuFields.push(unit(cpuPower, (n) => n.toFixed(1), 'W'));
  // M14: the Memory row - the memory-util stat only ('RAM 12.4GB' - the
  // M13 row label + the gbValue decimal-GB format; the honest '-' when
  // the field is null); '' when the stat is off.
  const memoryFields = enabled.has('memory-util') ? [unit(memoryUsed, (n) => gbValue(n), 'GB')] : [];
  const gpuFields: string[] = [];
  if (enabled.has('gpu-util')) gpuFields.push(pct(gpuUtil));
  if (enabled.has('gpu-clock')) gpuFields.push(unit(gpuClock, (n) => String(n), 'MHz'));
  if (enabled.has('gpu-temp')) gpuFields.push(unit(gpuTemp, (n) => String(Math.round(n)), '°C'));
  // M16: the GPU voltage - a GPU-row field between the temp and the power
  // fields (volts with 3 decimals - the mock 0.652 reads '0.652V'; the
  // honest '-' when null). The amended shape: NO standalone Voltage row.
  if (enabled.has('gpu-voltage')) gpuFields.push(unit(gpuVoltage, (n) => n.toFixed(3), 'V'));
  if (enabled.has('gpu-power')) gpuFields.push(unit(power, (n) => n.toFixed(1), 'W'));
  if (enabled.has('gpu-fan')) gpuFields.push(unit(fan, (n) => String(n), 'RPM'));
  // M16: the VRAM row - the mem-clock field LEADS, then the VRAM usage, then
  // the VRAM temperature (the user's requested 'MemClock;VRAM;VramTEMP'
  // order). Each field vanishes with its stat; the row writes '' only when
  // ALL THREE are off.
  const vramFields: string[] = [];
  if (enabled.has('gpu-mem-clock')) vramFields.push(unit(memClock, (n) => String(n), 'MHz'));
  if (enabled.has('gpu-vram')) vramFields.push(unit(vram, (n) => gbValue(n), 'GB'));
  if (enabled.has('gpu-vram-temp')) vramFields.push(unit(vramTemp, (n) => String(Math.round(n)), '°C'));
  // M18/M19b: the header-divider column labels - the SIX labeled rows (the
  // cpu/gpu entries carry the chip labels when enabled); M19b: the api
  // entry joins - the API row is the SIXTH labeled row of the divider
  // column (the M18 headerless decision REVERSED).
  const labels = { fps: 'FPS', cpu: cpuPrefix, memory: 'RAM', gpu: gpuPrefix, vram: 'VRAM', api: 'API' };
  // M19/M19b (the divider alignment - ONE rule): every NON-EMPTY row's
  // label is padded to the max label length with a TWO-space separator
  // after it (`label.padEnd(maxLabelLen) + '  ' + fields`), so EVERY
  // value starts at `maxLabelLen + 2 ch` - 2ch RIGHT of the divider's
  // left edge (the divider sits at maxLabelLen + 0.75ch, so the value-to-
  // divider gap is ~1.25ch; the rows are white-space:pre + monospace, so
  // space-padding is byte-exact). The empty-row degrade ('' when all
  // fields off) stays '' - no padding on an empty line. The `labels`
  // field itself stays UNPADDED (the renderer's --overlay-label-w column
  // var + the divider position derive from the raw lengths).
  const maxLabelLen = Math.max(labels.fps.length, labels.cpu.length, labels.memory.length, labels.gpu.length, labels.vram.length, labels.api.length);
  const labeledRow = (label: string, fields: string[]): string =>
    fields.length === 0 ? '' : `${label.padEnd(maxLabelLen)}  ${fields.join('  ')}`;
  const fpsLine = labeledRow(labels.fps, fpsFields);
  // M17b (2c): the chip-name label replaces the stock 'CPU ' prefix ONLY -
  // the field order is untouched.
  const cpuLine = labeledRow(labels.cpu, cpuFields);
  const memoryLine = labeledRow(labels.memory, memoryFields);
  // M17b (2c): the chip-name label replaces the stock 'GPU ' prefix ONLY -
  // the field order is untouched.
  const gpuLine = labeledRow(labels.gpu, gpuFields);
  const vramLine = labeledRow(labels.vram, vramFields);
  // M13: the standalone Graphics-API row - the api field LEFT the fpsLine.
  // M19b: the row builds through the SAME labeledRow rule as the other
  // five - the 'API' label padded to the max label length + the two-space
  // separator, so its value aligns with the divider column. The M10a
  // vanish rule is preserved: EMPTY ('' - the labeledRow empty degrade)
  // when the api is null/unknown ("if it's none, it won't display
  // anything" - never a '-', never a raw id) or the api stat is off.
  const apiFields: string[] = [];
  if (enabled.has('api')) {
    const badge = apiLabelOf(api);
    if (badge !== null) apiFields.push(badge);
  }
  const apiLine = labeledRow(labels.api, apiFields);
  return { fpsLine, cpuLine, memoryLine, gpuLine, vramLine, apiLine, labels, frametimeEnabled: enabled.has('frametime') };
}

/**
 * The frametime value for the polyline series. Passthrough when frameTimeMs
 * is a finite number > 0 (the RID_MOCK_FPS=1 16.7ms shape); else 1000 / fps
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
 * MAXIMUM 2 decimals, NEVER padded ('16.67ms', '16.7ms' - never
 * '16.70ms'; the passthrough 16.7 stays '16.7ms'). Honest '-' when
 * there is no data (null / non-finite / <= 0 - the fps-0 guard shape).
 * M18: the unit is GLUED to the number (no space - the frametime value
 * follows the glued-unit rule like every other value).
 */
export function formatFrametime(ft: number | null | undefined): string {
  if (typeof ft !== 'number' || !Number.isFinite(ft) || ft <= 0) return '-';
  return `${Math.round(ft * 100) / 100}ms`;
}
