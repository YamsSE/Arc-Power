// Arc Power - M10b the Graphics "Display" view: the pure page helpers
// (DOM-free, unit-tested). The display-settings validation / normalization
// / the dirty-vs-applied derivation compatible with the M9 chipState
// machine.
//
// The canonical vocabulary mirrors the main-process contract
// (src/main/backend/backend.interface.js option lists + ipc-core.js
// sanitizeDisplaySettings - the main side is the authoritative gate; this
// module keeps the UI honest before it ever sends a payload).
//
// The supportedOptions-gated dirty logic (the M8 S1 lesson): a control
// whose driver-supported option list is EMPTY (scalingMethods on this
// driver, wireFormats/bpcDepths on this driver build - the wire-format
// surface is read-only in effect) is NEVER dirty and NEVER enters the
// payload - the honest read-only state the page renders.

import type { DisplaySettings, DisplayState } from '../types.ts';

export type Display = DisplayState['displays'][number];

// The option lists - the renderer mirror of the main-side contract (the
// page never re-derives them; a driver-gated option list comes from the
// state's supportedOptions).
export const DISPLAY_QUANTIZATION_OPTIONS: NonNullable<DisplaySettings['quantizationRange']>[] = ['default', 'limited', 'full'];
export const DISPLAY_WIRE_FORMAT_OPTIONS: NonNullable<DisplaySettings['wireFormat']>['model'][] = ['RGB', 'YCbCr420', 'YCbCr422', 'YCbCr444'];
export const DISPLAY_BPC_OPTIONS = [6, 8, 10, 12];
export const DISPLAY_SCALING_MODE_OPTIONS: NonNullable<DisplaySettings['scalingMode']>[] = ['identity', 'centered', 'stretched', 'aspect-ratio-centered-max', 'custom'];

/**
 * M10b: true when the driver exposes `control` on this display (the
 * supportedOptions gate - the M8 S1 lesson). False when the control's
 * driver-gated option list is empty (an optionless control offers no
 * appliable values - the page shows the honest read-only/no-control state)
 * or the display is null. The wireFormat control needs BOTH lists
 * non-empty (the composite { model, depth } pair). A null display has no
 * options info -> false (the safe direction: never dirty, never sendable).
 */
export function isDisplayControlSupported(display: Display | null | undefined, control: string): boolean {
  if (!display) return false;
  switch (control) {
    case 'quantizationRange': return display.supportedOptions.quantizationRanges.length > 0;
    case 'scalingMode': return display.supportedOptions.scalingModes.length > 0;
    case 'wireFormat': return display.supportedOptions.wireFormats.length > 0 && display.supportedOptions.bpcDepths.length > 0;
    default: return false;
  }
}

/** The driver's current value of `control` (the chip machine's driverValue
 *  side). The wireFormat composite reads null when either member is
 *  missing (the driver's never-populated ColorDepth on this build). */
export function displayDriverValue(display: Display | null | undefined, control: string): unknown {
  if (!display) return null;
  switch (control) {
    case 'quantizationRange': return display.quantizationRange;
    case 'scalingMode': return display.scalingMode;
    case 'wireFormat': {
      const { colorFormat, colorDepth } = display;
      if (colorFormat === null || colorDepth === null) return null;
      return { model: colorFormat, depth: colorDepth };
    }
    default: return null;
  }
}

/**
 * The page's editable draft for ONE display, normalized from the driver
 * read-back: every SUPPORTED control resolves to a concrete value (the
 * driver's current value; the supportedOptions' first entry when the
 * driver reports none). The wireFormat composite falls back to the first
 * wire format + the first BPC depth.
 *
 * The M8 S1 lesson: an UNSUPPORTED control's key stays OUT of the draft
 * (the optionless card renders the honest note without a control - the key
 * must not exist for the dirty/payload derivation to see). The null-display
 * fallback returns the empty draft (the page only calls this after a
 * successful read).
 */
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
    const model = (display.colorFormat ?? display.supportedOptions.wireFormats[0]) as NonNullable<DisplaySettings['wireFormat']>['model'];
    const depth = display.colorDepth ?? display.supportedOptions.bpcDepths[0];
    out.wireFormat = { model, depth };
  }
  return out;
}

const QUANTIZATION_SET = new Set<unknown>(DISPLAY_QUANTIZATION_OPTIONS);
const WIRE_FORMAT_SET = new Set<unknown>(DISPLAY_WIRE_FORMAT_OPTIONS);
const SCALING_MODE_SET = new Set<unknown>(DISPLAY_SCALING_MODE_OPTIONS);

/**
 * True when `value` is a legal display-settings payload (the renderer-side
 * mirror of the main validator): known keys, known option strings, a
 * well-formed wireFormat { model, depth } pair.
 */
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
      if (!WIRE_FORMAT_SET.has(wf.model)) return false;
      if (typeof wf.depth !== 'number' || !Number.isFinite(wf.depth) || !DISPLAY_BPC_OPTIONS.includes(wf.depth)) return false;
    } else {
      return false; // unknown key
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Dirty / applied-reference derivation (the chip pattern)
// ---------------------------------------------------------------------------

function sameWireFormat(a: { model: string; depth: number } | null | undefined, b: { model: string; depth: number } | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.model === b.model && a.depth === b.depth;
}

/**
 * True when ONE control of the draft differs from the driver's read-back
 * (a missing driver value counts as dirty - the UI must surface an
 * unapplied state it cannot verify). Null-safe: a null display is never
 * dirty, never throws (nothing loaded yet).
 *
 * The M8 S1 lesson: an UNSUPPORTED control is NEVER dirty (the null driver
 * value for an optionless control must not count - e.g. the wire-format
 * surface on this driver build, read-only in effect).
 */
export function isDisplayControlDirty(control: string, draft: DisplaySettings, display: Display | null): boolean {
  if (!(control in draft)) return false;
  if (!display) return false;
  if (!isDisplayControlSupported(display, control)) return false;
  const wanted = (draft as Record<string, unknown>)[control];
  const driver = displayDriverValue(display, control);
  if (driver === null || driver === undefined) return true;
  if (typeof wanted === 'string') return wanted !== driver;
  return !sameWireFormat(wanted as { model: string; depth: number }, driver as { model: string; depth: number });
}

/**
 * Is `control` dirty against the APPLIED reference (the per-control
 * result.ok values from the last apply) falling back to the driver state?
 * A control in `applied` is judged against the applied value alone - a
 * lagging read-back cannot re-dirty a chip that just applied.
 */
export function isDisplayControlDirtyVsApplied(control: string, draft: DisplaySettings, display: Display | null, applied: DisplaySettings): boolean {
  if (!(control in draft)) return false;
  // The M8 S1 lesson applies to the applied-reference path too - an
  // unsupported control can never have been applied (the backend refuses
  // it) and must never re-dirty the page.
  if (display && !isDisplayControlSupported(display, control)) return false;
  const wanted = (draft as Record<string, unknown>)[control];
  if (control in applied) {
    const appliedValue = (applied as Record<string, unknown>)[control];
    if (typeof wanted === 'string') return wanted !== appliedValue;
    return !sameWireFormat(wanted as { model: string; depth: number }, appliedValue as { model: string; depth: number });
  }
  return isDisplayControlDirty(control, draft, display);
}

/**
 * Build the apply payload from the draft: only the controls that DIFFER
 * from the driver state are included (the "leave untouched" contract) -
 * except controls with an applied reference (the chip/button semantics
 * still send them when the user changed them after applying).
 *
 * The M8 S1 lesson: an UNSUPPORTED control NEVER enters the payload (the
 * backend would refuse it per-control 'unsupported' - a spurious refusal +
 * ok:false for a control the user never touched). The explicit skip is
 * belt-and-braces on top of the dirty-predicate gate.
 */
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
