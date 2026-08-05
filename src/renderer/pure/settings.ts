// Arc Power — apply-settings payload validation + building (pure, DOM-free).
//
// Mirrors the main-process contract (src/main/ipc-core.js sanitizeSettings):
// keys must be CONTROLS, scalar values finite numbers, gpuLock a well-formed
// pair, vfCurve/fanCurve well-formed arrays. The main process is the
// authoritative gate; this module keeps the UI honest before it ever sends a
// payload, and builds the payload from slider state.

import type { DeviceState, FanMode, Settings } from '../types.ts';
import { MAX_CURVE_POINTS } from './curve.ts';

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
 * Any-dirty predicate for a Settings payload vs the driver read-back. Drives
 * the floating Apply button (M2b-B): shown only when something differs from
 * the loaded driver state.
 */
export function computeDirty(settings: Settings, state: DeviceState): boolean {
  for (const key of Object.keys(settings)) {
    if (isControlDirty(key, settings, state)) return true;
  }
  return false;
}

/**
 * No-op apply predicate (M2b-B toast suppression): true when the requested
 * value for `control` equals the driver's value BEFORE the apply — i.e. the
 * apply changed nothing for that control, so a success toast would be noise.
 * Call with the pre-apply state snapshot.
 */
export function isNoopApply(control: string, settings: Settings, beforeState: DeviceState): boolean {
  return !isControlDirty(control, settings, beforeState);
}

/**
 * M2b review F3: the "Applied on retry" note is only truthful when the
 * retried apply SUCCEEDED — the main-process handler also sets `retried` on
 * an apply that exhausted its retries and ultimately failed, and the note
 * would then be a lie. Gate both the toast and the flag.
 */
export function shouldShowRetryNote(result: { retried?: boolean; ok?: boolean }): boolean {
  return result.retried === true && result.ok === true;
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
