// Arc Power — apply-settings payload validation + building (pure, DOM-free).
//
// Mirrors the main-process contract (src/main/ipc-core.js sanitizeSettings):
// keys must be CONTROLS, scalar values finite numbers, gpuLock a well-formed
// pair, vfCurve/fanCurve well-formed arrays. The main process is the
// authoritative gate; this module keeps the UI honest before it ever sends a
// payload, and builds the payload from slider state.

import type { Capabilities, DeviceState, FanMode, RangeInfo, Settings } from '../types.ts';
import { MAX_CURVE_POINTS } from './curve.ts';

// F3 PT clamp (M2C-A): the driver setter refuses temp limits above 90 C
// (0x44000005); the exposed max is pinned here on top of the backend clamp so
// sliders/presets can never offer an un-appliable value. M2C-C: the pin
// yields to the extended range (115 C) when the device reports
// caps.extendedRanges — values above 90 C then route to the bundled 2023
// IGCL runtime.
export const TEMP_LIMIT_MAX_C = 90;
export const EXTENDED_PL_MAX_W = 315;
export const EXTENDED_TL_MAX_C = 115;
// The DriverStore-runtime clamps: applies above these route to the bundled
// 2023 runtime and need the extended-range confirm dialog.
export const STD_PL_MAX_W = 252;
export const STD_TL_MAX_C = 90;

/**
 * Clamp the exposed range for tempLimitC to TEMP_LIMIT_MAX_C (F3). Other
 * controls pass through untouched. Backend capabilities are already capped,
 * but a stale cache or a future driver props drift must not widen the slider.
 * M2C-C: when the device reports extended ranges, the temp slider may go up
 * to 115 C (the backend range already says so — pass it through).
 */
export function clampExposedRange(range: RangeInfo | undefined, key: string, caps?: Capabilities): RangeInfo | undefined {
  if (!range) return range;
  if (key === 'powerLimitW' && !caps?.extendedRanges && range.max > STD_PL_MAX_W) {
    return { ...range, max: STD_PL_MAX_W, default: Math.min(range.default, STD_PL_MAX_W) };
  }
  if (key === 'tempLimitC' && !caps?.extendedRanges && range.max > TEMP_LIMIT_MAX_C) {
    return { ...range, max: TEMP_LIMIT_MAX_C, default: Math.min(range.default, TEMP_LIMIT_MAX_C) };
  }
  return range;
}

/**
 * M2C-C: true when the pending settings contain an extended-range value
 * (PL > 252 W or TL > 90 C) — the apply must pass the extended-range confirm
 * dialog first (honest warning: beyond Intel's standard limit; card/driver
 * dependent; the Acer BiFrost profile used 300 W).
 */
export function requiresExtendedRangeConfirm(settings: Settings): boolean {
  return (typeof settings.powerLimitW === 'number' && settings.powerLimitW > STD_PL_MAX_W)
    || (typeof settings.tempLimitC === 'number' && settings.tempLimitC > STD_TL_MAX_C);
}

const SCALAR_KEYS = new Set([
  'powerLimitW',
  'gpuVoltOffsetV',
  'gpuFreqOffsetMhz',
  'tempLimitC',
  'vramFreqOffsetGts',
  'vramVoltOffsetV',
  'fixedFanPct',
]);

const FAN_MODES = new Set<unknown>(['auto', 'curve', 'fixed']);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPointArray(v: unknown, fields: string[]): boolean {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_CURVE_POINTS) return false;
  return v.every((pt) => typeof pt === 'object' && pt !== null && fields.every((f) => isFiniteNumber((pt as Record<string, unknown>)[f])));
}

/**
 * True when `value` is a legal apply-settings payload: an object whose keys
 * are known controls and whose values are finite numbers / well-formed
 * arrays or objects. Anything else (unknown keys, NaN, garbage) is rejected.
 */
export function validateSettingsPayload(value: unknown): value is Settings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  for (const [key, v] of Object.entries(value)) {
    if (SCALAR_KEYS.has(key)) {
      if (!isFiniteNumber(v)) return false;
    } else if (key === 'fanMode') {
      if (!FAN_MODES.has(v)) return false;
    } else if (key === 'gpuLock') {
      if (typeof v !== 'object' || v === null || !isFiniteNumber((v as { voltageV?: unknown }).voltageV) || !isFiniteNumber((v as { freqMhz?: unknown }).freqMhz)) return false;
    } else if (key === 'vfCurve') {
      if (!isPointArray(v, ['voltageV', 'freqMhz'])) return false;
    } else if (key === 'fanCurve') {
      if (!isPointArray(v, ['t', 'speedPct'])) return false;
    } else {
      return false; // unknown key
    }
  }
  return true;
}

/**
 * Build a Settings payload from per-control slider values (only supported
 * controls are included). Values are assumed pre-snapped.
 */
export function buildScalarSettings(values: Record<string, number>): Settings {
  const out: Settings = {};
  for (const [key, v] of Object.entries(values)) {
    if (SCALAR_KEYS.has(key) && isFiniteNumber(v)) {
      (out as Record<string, number>)[key] = v;
    }
  }
  return out;
}

/** Build a fan Settings payload from editor state. */
export function buildFanSettings(mode: FanMode, curve: Array<{ t: number; speedPct: number }>, fixedPct: number): Settings {
  const out: Settings = { fanMode: mode };
  if (mode === 'curve') out.fanCurve = curve;
  if (mode === 'fixed') out.fixedFanPct = fixedPct;
  return out;
}

// ---------------------------------------------------------------------------
// Dirty / no-op detection (M2b-B)
// ---------------------------------------------------------------------------

function samePair(a: { voltageV: number; freqMhz: number } | null | undefined, b: { voltageV: number; freqMhz: number } | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.voltageV === b.voltageV && a.freqMhz === b.freqMhz;
}

function samePointArray(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * True when one control of `settings` differs from the driver's read-back
 * `state` (a missing driver value counts as dirty — the UI must surface an
 * unapplied state it cannot verify).
 */
export function isControlDirty(control: string, settings: Settings, state: DeviceState): boolean {
  if (!(control in settings)) return false;
  const wanted = (settings as Record<string, unknown>)[control];
  const driver = (state as unknown as Record<string, unknown>)[control];
  if (driver === null || driver === undefined) return true;
  if (typeof wanted === 'number') return wanted !== driver;
  if (typeof wanted === 'string') return wanted !== driver;
  if (control === 'gpuLock') return !samePair(wanted as { voltageV: number; freqMhz: number }, driver as { voltageV: number; freqMhz: number });
  return !samePointArray(wanted, driver); // fanCurve / vfCurve
}

/**
 * No-op apply predicate (M2b-B toast suppression): true when the requested
 * value for `control` equals the driver's value BEFORE the apply — i.e. the
 * apply changed nothing for that control, so a success toast would be noise.
 * Call with the pre-apply state snapshot. (M2C-B B5(b): the no-op comparison
 * STAYS against the driver read-back — the silent-success rule survives the
 * applied-reference change.)
 */
export function isNoopApply(control: string, settings: Settings, beforeState: DeviceState): boolean {
  return !isControlDirty(control, settings, beforeState);
}

// ---------------------------------------------------------------------------
// M2C-B B5 — applied-reference dirty detection (chips + floating Apply)
// ---------------------------------------------------------------------------
//
// Two separate references, deliberately NOT merged:
//   (a) the dirty reference for the "Unapplied" chips AND the floating Apply
//       button: per-`result.ok` control it becomes the APPLIED value, so the
//       chip clears and the button hides even while the driver read-back
//       lags (the mock/A770 read-back can trail the write);
//   (b) the no-op suppression comparison stays against the driver read-back
//       (isNoopApply, untouched) so the silent-success rule survives.

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') return a === b;
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const pa = a as Record<string, unknown>;
    const pb = b as Record<string, unknown>;
    if ('voltageV' in pa && 'voltageV' in pb) return pa.voltageV === pb.voltageV && pa.freqMhz === pb.freqMhz;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * B5(a): is `control` dirty against the APPLIED reference (per-control
 * result.ok values from the last apply) falling back to the driver state?
 * A control in `applied` is judged against the applied value alone — the
 * lagging driver read-back cannot re-dirty a chip that just applied.
 */
export function isControlDirtyVsApplied(control: string, settings: Settings, state: DeviceState, applied: Record<string, unknown>): boolean {
  if (!(control in settings)) return false;
  const wanted = (settings as Record<string, unknown>)[control];
  if (control in applied) return !sameValue(wanted, applied[control]);
  return isControlDirty(control, settings, state);
}

/**
 * B5(a): any-dirty predicate for the floating Apply button against the
 * applied reference + driver state.
 */
export function computeDirtyVsApplied(settings: Settings, state: DeviceState, applied: Record<string, unknown>): boolean {
  for (const key of Object.keys(settings)) {
    if (isControlDirtyVsApplied(key, settings, state, applied)) return true;
  }
  return false;
}

/**
 * B5(a): scalar variant for the per-card "Unapplied" chips (slider values
 * are numbers; the driver may report none — then it counts as dirty).
 */
export function isScalarDirtyVsApplied(control: string, value: number, state: DeviceState, applied: Record<string, unknown>): boolean {
  if (control in applied) return value !== applied[control];
  const driver = (state as unknown as Record<string, unknown>)[control];
  return driver === null || driver === undefined ? true : value !== driver;
}

/**
 * Post-apply profile-load outcome (M2b step-5 NIT 2): the active-profile
 * mark and the "applied to the GPU" wording are gated on `result.ok` — a
 * partially-failed load (some controls errored, `ok === false`) must NOT
 * mark the profile active nor claim the GPU state; the per-control error
 * toasts already covered it. Returns no toast when nothing should be shown.
 */
export function profileApplyOutcome(
  result: { ok: boolean },
  name: string,
  changed: number,
): { markActive: boolean; toast: string | null } {
  if (result.ok !== true) return { markActive: false, toast: null };
  return {
    markActive: true,
    toast: changed > 0
      ? `"${name}" applied to the GPU.`
      : `"${name}" matches the current GPU state — nothing changed.`,
  };
}
