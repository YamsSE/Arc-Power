// Arc Power - pure helpers for the Graphics > Display view.
//
// These helpers deliberately only describe controls that have a verified
// driver contract. Capability rows that are not writable stay outside the
// payload and are rendered as read-only by the page.

import type { DisplaySettings, DisplayState } from '../types.ts';

export type Display = DisplayState['displays'][number];

export const DISPLAY_QUANTIZATION_OPTIONS: NonNullable<DisplaySettings['quantizationRange']>[] = ['default', 'limited', 'full'];
export const DISPLAY_WIRE_FORMAT_OPTIONS: NonNullable<DisplaySettings['wireFormat']>['model'][] = ['RGB', 'YCbCr420', 'YCbCr422', 'YCbCr444'];
export const DISPLAY_BPC_OPTIONS = [6, 8, 10, 12];
export const DISPLAY_SCALING_MODE_OPTIONS: NonNullable<DisplaySettings['scalingMode']>[] = ['identity', 'centered', 'stretched', 'aspect-ratio-centered-max', 'custom'];
export const DISPLAY_RETRO_SCALING_METHOD_OPTIONS: NonNullable<DisplaySettings['scalingMethod']>['method'][] = ['integer', 'nearest-neighbour'];
export const DISPLAY_ARC_SYNC_PROFILE_OPTIONS: NonNullable<DisplaySettings['vrrMode']>[] = ['recommended', 'excellent', 'good', 'compatible', 'off', 'vesa', 'custom'];

export function isDisplayControlSupported(display: Display | null | undefined, control: string): boolean {
  if (!display || display.identityVerified !== true || typeof display.displayKey !== 'string' || display.displayKey.length === 0) return false;
  switch (control) {
    case 'quantizationRange': return display.supportedOptions.quantizationRanges.length > 0;
    case 'scalingMode': return display.supportedOptions.scalingModes.length > 0;
    case 'scalingMethod': return display.scalingMethod?.controllable === true && display.supportedOptions.scalingMethods.length > 0;
    case 'vrrMode': return display.vrrMode?.controllable === true && (display.supportedOptions.vrrModes ?? []).length > 0;
    case 'wireFormat': return display.supportedOptions.wireFormats.length > 0 && display.supportedOptions.bpcDepths.length > 0;
    default: return false;
  }
}

export function displayDriverValue(display: Display | null | undefined, control: string): unknown {
  if (!display) return null;
  switch (control) {
    case 'quantizationRange': return display.quantizationRange;
    case 'scalingMode': return display.scalingMode;
    case 'scalingMethod': return display.scalingMethod?.value;
    case 'vrrMode': return display.vrrMode?.value;
    case 'wireFormat': {
      if (display.colorFormat === null || display.colorDepth === null) return null;
      return { model: display.colorFormat, depth: display.colorDepth };
    }
    default: return null;
  }
}

export function normalizeDisplaySettings(display: Display | null | undefined): DisplaySettings {
  const out: DisplaySettings = {};
  if (!display) return out;
  if (isDisplayControlSupported(display, 'quantizationRange')) {
    out.quantizationRange = display.quantizationRange ?? display.supportedOptions.quantizationRanges[0] as DisplaySettings['quantizationRange'];
  }
  if (isDisplayControlSupported(display, 'scalingMode')) {
    out.scalingMode = (display.scalingMode ?? display.supportedOptions.scalingModes[0]) as DisplaySettings['scalingMode'];
  }
  if (isDisplayControlSupported(display, 'scalingMethod') && display.scalingMethod?.value) {
    out.scalingMethod = {
      enabled: display.scalingMethod.value.enabled,
      method: display.scalingMethod.value.method,
    };
  }
  if (isDisplayControlSupported(display, 'vrrMode') && display.vrrMode?.value) {
    out.vrrMode = display.vrrMode.value;
  }
  if (isDisplayControlSupported(display, 'wireFormat')) {
    out.wireFormat = {
      model: (display.colorFormat ?? display.supportedOptions.wireFormats[0]) as NonNullable<DisplaySettings['wireFormat']>['model'],
      depth: display.colorDepth ?? display.supportedOptions.bpcDepths[0],
    };
  }
  return out;
}

const QUANTIZATION_SET = new Set<unknown>(DISPLAY_QUANTIZATION_OPTIONS);
const WIRE_FORMAT_SET = new Set<unknown>(DISPLAY_WIRE_FORMAT_OPTIONS);
const SCALING_MODE_SET = new Set<unknown>(DISPLAY_SCALING_MODE_OPTIONS);
const RETRO_SCALING_METHOD_SET = new Set<unknown>(DISPLAY_RETRO_SCALING_METHOD_OPTIONS);
const ARC_SYNC_PROFILE_SET = new Set<unknown>(DISPLAY_ARC_SYNC_PROFILE_OPTIONS);

export function validateDisplaySettings(value: unknown): value is DisplaySettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  for (const [key, v] of Object.entries(value)) {
    if (key === 'quantizationRange') {
      if (!QUANTIZATION_SET.has(v)) return false;
    } else if (key === 'scalingMode') {
      if (!SCALING_MODE_SET.has(v)) return false;
    } else if (key === 'scalingMethod') {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
      const sm = v as { enabled?: unknown; method?: unknown };
      if (typeof sm.enabled !== 'boolean' || !RETRO_SCALING_METHOD_SET.has(sm.method)) return false;
    } else if (key === 'vrrMode') {
      if (!ARC_SYNC_PROFILE_SET.has(v)) return false;
    } else if (key === 'wireFormat') {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
      const wf = v as { model?: unknown; depth?: unknown };
      if (!WIRE_FORMAT_SET.has(wf.model) || typeof wf.depth !== 'number' || !Number.isFinite(wf.depth) || !DISPLAY_BPC_OPTIONS.includes(wf.depth)) return false;
    } else {
      return false;
    }
  }
  return true;
}

function sameWireFormat(a: { model: string; depth: number } | null | undefined, b: { model: string; depth: number } | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.model === b.model && a.depth === b.depth;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

export function isDisplayControlDirty(control: string, draft: DisplaySettings, display: Display | null): boolean {
  if (!(control in draft) || !display || !isDisplayControlSupported(display, control)) return false;
  const wanted = (draft as Record<string, unknown>)[control];
  const driver = displayDriverValue(display, control);
  if (driver === null || driver === undefined) return true;
  if (typeof wanted === 'string') return wanted !== driver;
  if (control === 'wireFormat') return !sameWireFormat(wanted as { model: string; depth: number }, driver as { model: string; depth: number });
  return !sameValue(wanted, driver);
}

export function isDisplayControlDirtyVsApplied(control: string, draft: DisplaySettings, display: Display | null, applied: DisplaySettings): boolean {
  if (!(control in draft) || (display && !isDisplayControlSupported(display, control))) return false;
  const wanted = (draft as Record<string, unknown>)[control];
  if (control in applied) {
    const appliedValue = (applied as Record<string, unknown>)[control];
    if (typeof wanted === 'string') return wanted !== appliedValue;
    if (control === 'wireFormat') return !sameWireFormat(wanted as { model: string; depth: number }, appliedValue as { model: string; depth: number });
    return !sameValue(wanted, appliedValue);
  }
  return isDisplayControlDirty(control, draft, display);
}

export function buildDisplaySettings(draft: DisplaySettings, display: Display | null, applied: DisplaySettings): DisplaySettings {
  const out: DisplaySettings = {};
  for (const key of Object.keys(draft) as (keyof DisplaySettings)[]) {
    if (display && !isDisplayControlSupported(display, key)) continue;
    if (isDisplayControlDirtyVsApplied(key, draft, display, applied)) {
      (out as Record<string, unknown>)[key] = (draft as Record<string, unknown>)[key];
    }
  }
  return out;
}
