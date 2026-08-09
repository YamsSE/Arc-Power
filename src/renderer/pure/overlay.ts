// Arc Power - M5 software-overlay model (pure, DOM-free; unit-tested).
//
// The overlay window renders three BOLD monospace lines (FPS / CPU / GPU)
// plus a frametime polyline. This module owns the line formatting + the
// frametime derivation so the renderer stays thin; every function here is
// unit-tested (the cheap-oracle seam of the milestone). The example strings
// in the plan are ILLUSTRATIVE - the tests pin the REAL expected strings.
//
// Field format: one value + its unit per field ('42%', '4.3 GHz', '61°C'),
// '-' for a null field (the unit is dropped with it - the honest degrade,
// never an invented number). Two spaces separate the fields (column
// alignment like the monitor log).

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

export function isValidOverlayPosition(v: unknown): v is OverlayPosition {
  return typeof v === 'string' && (OVERLAY_POSITIONS as readonly string[]).includes(v);
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
}

export interface OverlayLines {
  fpsLine: string;
  cpuLine: string;
  gpuLine: string;
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
 * Build the three overlay lines from one telemetry sample + the latest FPS
 * (the 1 s fps-poll result). Every field degrades honestly to '-':
 *   fpsLine: 'FPS 60' (rounded like the Monitoring tile) / 'FPS -' for
 *     null, non-finite or <= 0 fps (0 is the DXGI no-signal shape - not a
 *     real frame rate);
 *   cpuLine: 'CPU 42%  4.3 GHz  61°C' (Util / Clock via ghzFreq / Temp);
 *   gpuLine: 'GPU 42%  2500 MHz  2187 MHz  8.5 GB  65°C  122 W  1030 RPM'
 *     (Util / Core clock / Memory clock / VRAM via gbValue / Temp / Power
 *     with ONE decimal (toFixed(1) - 38.8) / Fan (first RPM of the array)).
 */
export function overlayLines(sample: OverlaySample | null | undefined, fps: number | null | undefined): OverlayLines {
  const s = sample ?? {};
  const pct = (v: number | null): string => (v === null ? '-' : `${v}%`);
  const cpuUtil = numOrNull(s.cpuUtilPct);
  const cpuFreqMhz = numOrNull(s.cpuFreqMhz);
  const cpuTemp = numOrNull(s.cpuTempC);
  // The device utilPct wins; the OS counter is the fallback (both null -> '-').
  const gpuUtil = numOrNull(s.utilPct) ?? numOrNull(s.gpuUtilPct);
  const gpuClock = numOrNull(s.gpuClockMhz);
  const memClock = numOrNull(s.memClockMhz);
  const vram = numOrNull(s.gpuMemUsedBytes);
  const gpuTemp = numOrNull(s.tempC);
  const power = numOrNull(s.powerW);
  const fan = Array.isArray(s.fanRpm) ? numOrNull(s.fanRpm[0]) : null;
  const fpsNum = numOrNull(fps);
  const fpsLine = fpsNum !== null && fpsNum > 0 ? `FPS ${Math.round(fpsNum)}` : 'FPS -';
  const cpuLine = `CPU ${pct(cpuUtil)}  ${unit(cpuFreqMhz, (n) => ghzFreq(n), ' GHz')}  ${unit(cpuTemp, (n) => String(n), '°C')}`;
  const gpuLine = [
    `GPU ${pct(gpuUtil)}`,
    unit(gpuClock, (n) => String(n), ' MHz'),
    unit(memClock, (n) => String(n), ' MHz'),
    unit(vram, (n) => gbValue(n), ' GB'),
    unit(gpuTemp, (n) => String(n), '°C'),
    unit(power, (n) => n.toFixed(1), ' W'),
    unit(fan, (n) => String(n), ' RPM'),
  ].join('  ');
  return { fpsLine, cpuLine, gpuLine };
}

/**
 * The frametime value for the polyline series. Passthrough when frameTimeMs
 * is a finite number > 0 (the RID_MOCK_FPS=1 16.7 ms shape); else 1000 / fps
 * when fps is a finite number > 0, rounded to ONE decimal (16.666.. -> 16.7 -
 * the readout style); else null (nothing drawn). The fps-0 guard: the real
 * DXGI adapter returns fps: 0 on its no-signal paths, and 1000/0 = Infinity
 * would poison the series + the canvas scaling - it must never enter.
 */
export function deriveFrameTimeMs(fps: number | null | undefined, frameTimeMs: number | null | undefined): number | null {
  if (typeof frameTimeMs === 'number' && Number.isFinite(frameTimeMs) && frameTimeMs > 0) {
    return frameTimeMs;
  }
  if (typeof fps === 'number' && Number.isFinite(fps) && fps > 0) {
    return Math.round((1000 / fps) * 10) / 10;
  }
  return null;
}
