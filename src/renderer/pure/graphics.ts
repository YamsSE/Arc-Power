// Arc Power - M8 the Graphics tab: the pure page helpers (DOM-free,
// unit-tested). The graphics-settings validation / normalization / the
// range-driven frame-limit clamp / the dirty-vs-applied derivation.
//
// The canonical vocabulary mirrors the main-process contract
// (src/main/backend/backend.interface.js option lists + ipc-core.js
// sanitizeGraphicsSettings - the main side is the authoritative gate; this
// module keeps the UI honest before it ever sends a payload).

import type { FrameGenOverride, FlipMode, GraphicsSettings, GraphicsState, LowLatency } from '../types.ts';

// The option lists - the renderer mirror of the main-side contract (the
// page never re-derives them; a driver-gated option list comes from the
// state's supportedOptions).
export const FRAME_GEN_OPTIONS: FrameGenOverride[] = ['app-choice', '2x', '3x', '4x'];
export const FLIP_MODE_OPTIONS: FlipMode[] = ['application-default', 'vsync-on', 'vsync-off', 'smooth-sync', 'speed-frame'];
export const LOW_LATENCY_OPTIONS: LowLatency[] = ['off', 'on', 'on-boost'];

// The frame-limit slider range fallback (the plan: range-driven, never a
// hardcoded 30-300 that could offer an un-appliable value - the fallback
// ONLY applies when the driver reports no range; the probe-recorded driver
// range IS 30-300-1-60).
export const FRAME_LIMIT_RANGE_FALLBACK = { min: 30, max: 300, step: 1, default: 60 };

export type FrameLimitRange = { min: number; max: number; step: number; default: number };

// The control -> caps-gate map (M8 finding-1, the STRUCTURAL fix): the
// dirty/apply derivation is gated on the state's supported flags exactly
// like the card DISPLAY is. A feature the driver does not expose
// (supported[X] === false - e.g. frameGen on an older driver without
// CTL_3D_FEATURE_FRAME_GENERATION) or whose SupportedTypes-gated option
// list came back EMPTY renders the honest 'Not supported on this GPU.'
// card WITHOUT a control - its control must therefore NEVER count as dirty
// (the null driver value would) and NEVER enter an apply payload (the
// backend would refuse it per-control 'unsupported').
const CONTROL_SUPPORT_KEY: Record<string, keyof GraphicsState['supported']> = {
  frameGenOverride: 'frameGen',
  flipMode: 'flipModes',
  frameLimit: 'frameLimit',
  lowLatency: 'lowLatency',
};
const CONTROL_OPTIONS_KEY: Record<string, keyof GraphicsState['supportedOptions']> = {
  frameGenOverride: 'frameGen',
  flipMode: 'flipModes',
  lowLatency: 'lowLatency',
};

/**
 * M8 finding-1: true when the driver exposes `control` on this device (the
 * caps gate). False for a feature whose supported flag is false OR whose
 * supportedOptions list is empty (a supported-but-optionless feature offers
 * no appliable values - the page shows the honest no-control state). A null
 * state has no caps info -> false (the safe direction: never dirty, never
 * sendable; the dirty predicates independently never dirty a null state).
 */
export function isGraphicsControlSupported(state: GraphicsState | null | undefined, control: string): boolean {
  const supportKey = CONTROL_SUPPORT_KEY[control];
  if (!supportKey || !state) return false;
  if (state.supported[supportKey] !== true) return false;
  const optionsKey = CONTROL_OPTIONS_KEY[control];
  if (optionsKey && state.supportedOptions[optionsKey].length === 0) return false;
  return true;
}

/**
 * The frame-limit slider range: the driver-reported range when present,
 * else the 30-300-1-60 fallback (the mock + the probe-recorded A770 driver
 * both report 30-300-1-60, so the fallback is only a defensive floor).
 * @param {GraphicsState | null | undefined} state
 * @returns {FrameLimitRange}
 */
export function frameLimitRange(state: GraphicsState | null | undefined): FrameLimitRange {
  const r = state?.frameLimitRange;
  if (r && Number.isFinite(r.min) && Number.isFinite(r.max) && r.max > r.min) return r;
  return FRAME_LIMIT_RANGE_FALLBACK;
}

/**
 * Clamp a frame-limit value into the range, snapped to the step. Garbage
 * (NaN / non-number) degrades to the range default. The slider + the apply
 * path share this clamp so the UI can never offer an un-appliable value.
 */
export function clampFrameLimitValue(value: unknown, range: FrameLimitRange): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : range.default;
  const snapped = range.step > 0 ? Math.round(n / range.step) * range.step : n;
  return Math.min(range.max, Math.max(range.min, snapped));
}

/**
 * The page's editable draft, normalized from the driver read-back: every
 * SUPPORTED control resolves to a concrete value (the driver's current
 * value; the option lists' first entry when the driver reports none). The
 * frame-limit value is clamped into the range (the live driver can report
 * an off-range value - e.g. { enabled: true, value: 0 } - the page never
 * offers it raw).
 *
 * M8 finding-1: an UNSUPPORTED control's key stays OUT of the draft (the
 * caps-gated card renders the honest note without a control - the key must
 * not exist for the dirty/payload derivation to see). The null-state
 * fallback keeps the full draft (the page only calls this after a
 * successful read; the fallback is the defensive floor for the
 * apply/validation path).
 */
export function normalizeGraphicsSettings(state: GraphicsState | null | undefined): GraphicsSettings {
  const range = frameLimitRange(state);
  const values = state?.values;
  const options = state?.supportedOptions;
  const out: GraphicsSettings = {};
  if (!state) {
    out.frameGenOverride = options?.frameGen.length ? options.frameGen[0] : FRAME_GEN_OPTIONS[0];
    out.flipMode = options?.flipModes.length ? options.flipModes[0] : FLIP_MODE_OPTIONS[0];
    out.lowLatency = options?.lowLatency.length ? options.lowLatency[0] : LOW_LATENCY_OPTIONS[0];
    const fl = values?.frameLimit;
    out.frameLimit = { enabled: fl?.enabled === true, value: clampFrameLimitValue(fl?.value, range) };
    return out;
  }
  if (isGraphicsControlSupported(state, 'frameGenOverride')) {
    out.frameGenOverride = values?.frameGenOverride ?? options?.frameGen[0] ?? FRAME_GEN_OPTIONS[0];
  }
  if (isGraphicsControlSupported(state, 'flipMode')) {
    out.flipMode = values?.flipMode ?? options?.flipModes[0] ?? FLIP_MODE_OPTIONS[0];
  }
  if (isGraphicsControlSupported(state, 'lowLatency')) {
    out.lowLatency = values?.lowLatency ?? options?.lowLatency[0] ?? LOW_LATENCY_OPTIONS[0];
  }
  if (isGraphicsControlSupported(state, 'frameLimit')) {
    const fl = values?.frameLimit;
    out.frameLimit = { enabled: fl?.enabled === true, value: clampFrameLimitValue(fl?.value, range) };
  }
  return out;
}

const FRAME_GEN_SET = new Set<unknown>(FRAME_GEN_OPTIONS);
const FLIP_MODE_SET = new Set<unknown>(FLIP_MODE_OPTIONS);
const LOW_LATENCY_SET = new Set<unknown>(LOW_LATENCY_OPTIONS);

/**
 * True when `value` is a legal graphics-settings payload (the renderer-side
 * mirror of the main validator): known keys, known option strings, a
 * well-formed frameLimit { enabled: boolean, value: number }.
 */
export function validateGraphicsSettings(value: unknown): value is GraphicsSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  for (const [key, v] of Object.entries(value)) {
    if (key === 'frameGenOverride') {
      if (!FRAME_GEN_SET.has(v)) return false;
    } else if (key === 'flipMode') {
      if (!FLIP_MODE_SET.has(v)) return false;
    } else if (key === 'lowLatency') {
      if (!LOW_LATENCY_SET.has(v)) return false;
    } else if (key === 'frameLimit') {
      if (typeof v !== 'object' || v === null
        || typeof (v as { enabled?: unknown }).enabled !== 'boolean'
        || typeof (v as { value?: unknown }).value !== 'number'
        || !Number.isFinite((v as { value: number }).value)) return false;
    } else {
      return false; // unknown key
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Dirty / applied-reference derivation (the Tuning chip pattern)
// ---------------------------------------------------------------------------

function sameFrameLimit(a: { enabled: boolean; value: number } | null | undefined, b: { enabled: boolean; value: number } | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.enabled === b.enabled && a.value === b.value;
}

/**
 * True when ONE control of the draft differs from the driver's read-back
 * (a missing driver value counts as dirty - the UI must surface an
 * unapplied state it cannot verify). Null-safe: a null state is never
 * dirty, never throws (nothing loaded yet).
 *
 * M8 finding-1: an UNSUPPORTED control is NEVER dirty (the null driver
 * value for an unsupported feature must not count - the fallback fill used
 * to mark it dirty at page load, showing a spurious floating Apply).
 */
export function isGraphicsControlDirty(control: string, draft: GraphicsSettings, state: GraphicsState | null): boolean {
  if (!(control in draft)) return false;
  if (!state) return false;
  if (!isGraphicsControlSupported(state, control)) return false;
  const wanted = (draft as Record<string, unknown>)[control];
  const driver = state.values[control as keyof GraphicsState['values']];
  if (driver === null || driver === undefined) return true;
  if (typeof wanted === 'string') return wanted !== driver;
  return !sameFrameLimit(wanted as { enabled: boolean; value: number }, driver as { enabled: boolean; value: number } | null);
}

/**
 * B5(a): is `control` dirty against the APPLIED reference (the per-control
 * result.ok values from the last apply) falling back to the driver state?
 * A control in `applied` is judged against the applied value alone - a
 * lagging read-back cannot re-dirty a chip that just applied.
 */
export function isGraphicsControlDirtyVsApplied(control: string, draft: GraphicsSettings, state: GraphicsState | null, applied: GraphicsSettings): boolean {
  if (!(control in draft)) return false;
  // M8 finding-1: the caps gate applies to the applied-reference path too -
  // an unsupported control can never have been applied (the backend refuses
  // it) and must never re-dirty the page.
  if (state && !isGraphicsControlSupported(state, control)) return false;
  const wanted = (draft as Record<string, unknown>)[control];
  if (control in applied) {
    const appliedValue = (applied as Record<string, unknown>)[control];
    if (typeof wanted === 'string') return wanted !== appliedValue;
    return !sameFrameLimit(wanted as { enabled: boolean; value: number }, appliedValue as { enabled: boolean; value: number });
  }
  return isGraphicsControlDirty(control, draft, state);
}

/**
 * Any-dirty predicate for the floating Apply button against the applied
 * reference + the driver state (the Tuning computeDirtyVsApplied pattern).
 * Null-safe: a null state with no applied reference is never dirty.
 */
export function computeGraphicsDirty(draft: GraphicsSettings, state: GraphicsState | null, applied: GraphicsSettings): boolean {
  for (const key of Object.keys(draft)) {
    if (isGraphicsControlDirtyVsApplied(key, draft, state, applied)) return true;
  }
  return false;
}

/**
 * Build the apply payload from the draft: only the controls that DIFFER
 * from the driver state are included (the "leave untouched" contract) -
 * except controls with an applied reference (the chip/button semantics
 * still send them when the user changed them after applying).
 *
 * M8 finding-1: an UNSUPPORTED control NEVER enters the payload (the
 * backend would refuse it per-control 'unsupported' - a spurious refusal +
 * ok:false for a control the user never touched). The explicit skip is
 * belt-and-braces on top of the dirty-predicate gate.
 */
export function buildGraphicsSettings(draft: GraphicsSettings, state: GraphicsState | null, applied: GraphicsSettings): GraphicsSettings {
  const out: GraphicsSettings = {};
  for (const key of Object.keys(draft) as (keyof GraphicsSettings)[]) {
    if (state && !isGraphicsControlSupported(state, key)) continue;
    if (isGraphicsControlDirtyVsApplied(key, draft, state, applied)) {
      (out as Record<string, unknown>)[key] = (draft as Record<string, unknown>)[key];
    }
  }
  return out;
}
