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

export function isDisplayControlSupported(display: Display | null | undefined, control: string): boolean {
  if (!display || display.identityVerified !== true || typeof display.displayKey !== 'string' || display.displayKey.length === 0) return false;
  switch (control) {
    case 'quantizationRange': return display.supportedOptions.quantizationRanges.length > 0;
    case 'scalingMode': return display.supportedOptions.scalingModes.length > 0;
    case 'wireFormat': return display.supportedOptions.wireFormats.length > 0 && display.supportedOptions.bpcDepths.length > 0;
    default: return false;
  }
}

export function displayDriverValue(display: Display | null | undefined, control: string): unknown {
  if (!display) return null;
  switch (control) {
    case 'quantizationRange': return display.quantizationRange;
    case 'scalingMode': return display.scalingMode;
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

export function validateDisplaySettings(value: unknown): value is DisplaySettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  for (const [key, v] of Object.entries(value)) {
    if (key === 'quantizationRange') {
      if (!QUANTIZATION_SET.has(v)) return false;
    } else if (key === 'scalingMode') {
      if (!SCALING_MODE_SET.has(v)) return false;
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

export function isDisplayControlDirty(control: string, draft: DisplaySettings, display: Display | null): boolean {
  if (!(control in draft) || !display || !isDisplayControlSupported(display, control)) return false;
  const wanted = (draft as Record<string, unknown>)[control];
  const driver = displayDriverValue(display, control);
  if (driver === null || driver === undefined) return true;
  if (typeof wanted === 'string') return wanted !== driver;
  return !sameWireFormat(wanted as { model: string; depth: number }, driver as { model: string; depth: number });
}

export function isDisplayControlDirtyVsApplied(control: string, draft: DisplaySettings, display: Display | null, applied: DisplaySettings): boolean {
  if (!(control in draft) || (display && !isDisplayControlSupported(display, control))) return false;
  const wanted = (draft as Record<string, unknown>)[control];
  if (control in applied) {
    const appliedValue = (applied as Record<string, unknown>)[control];
    if (typeof wanted === 'string') return wanted !== appliedValue;
    return !sameWireFormat(wanted as { model: string; depth: number }, appliedValue as { model: string; depth: number });
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
