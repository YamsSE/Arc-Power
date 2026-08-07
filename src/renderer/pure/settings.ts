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
// M3-C-D: the extended PL ceiling. Live-verified 2026-08-06: 400/350/330 W
// are refused by the runtime (0x44000004), 315 W persists — 315 W IS the
// ceiling on this card (in lockstep with old-igcl.js / the backend ranges /
// the mock featureset / every pinning test). Requests above it are refused
// honestly by main, never clamped.
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
 * M2D: the W/C pins apply ONLY to canonical-unit ranges — percent-unit
 * featuresets (Battlemage mock: volt/PL/TL as %) are not DriverStore W/C
 * limits and must pass through untouched.
 */
export function clampExposedRange(range: RangeInfo | undefined, key: string, caps?: Capabilities): RangeInfo | undefined {
  if (!range) return range;
  if (key === 'powerLimitW' && range.units === 'W' && !caps?.extendedRanges && range.max > STD_PL_MAX_W) {
    return { ...range, max: STD_PL_MAX_W, default: Math.min(range.default, STD_PL_MAX_W) };
  }
  if (key === 'tempLimitC' && range.units === 'C' && !caps?.extendedRanges && range.max > TEMP_LIMIT_MAX_C) {
    return { ...range, max: TEMP_LIMIT_MAX_C, default: Math.min(range.default, TEMP_LIMIT_MAX_C) };
  }
  return range;
}

/**
 * M4-B step-5 F1: the slider range ONE OC card exposes — the raw capability
 * range passed through clampExposedRange. buildCard AND refreshCard must
 * derive from the SAME clamped range: the refresh path used to read the raw
 * range directly, so after any apply the slider min/max/step were rewritten
 * from the UNCLAMPED caps — a stale cache or a future driver props drift
 * would have silently widened the slider, removing the UI half of the M2C-A
 * F3 guard. Undefined (unknown control / no caps) -> undefined; the callers
 * guard before use.
 */
export function cardSliderRange(caps: Capabilities | null | undefined, key: string): RangeInfo | undefined {
  return clampExposedRange(caps?.ranges[key], key, caps ?? undefined);
}

/**
 * M2C-C: true when the pending settings contain an extended-range value
 * (PL > 252 W or TL > 90 C) — the apply must pass the extended-range confirm
 * dialog first (honest warning: beyond Intel's standard limit; card/driver
 * dependent; the Acer BiFrost profile used 300 W).
 * M2D: the extended-range concept is W/C-only — when the device caps are
 * known, percent-unit ranges (Battlemage mock: volt/PL/TL as %) never count
 * as extended (e.g. a 100% temp limit is not 100 C).
 */
export function requiresExtendedRangeConfirm(settings: Settings, caps?: Capabilities): boolean {
  const plRange = caps?.ranges?.powerLimitW;
  const tlRange = caps?.ranges?.tempLimitC;
  return (typeof settings.powerLimitW === 'number' && settings.powerLimitW > STD_PL_MAX_W && (!plRange || plRange.units === 'W'))
    || (typeof settings.tempLimitC === 'number' && settings.tempLimitC > STD_TL_MAX_C && (!tlRange || tlRange.units === 'C'));
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
 * M3-C review F2: NULL-SAFE — a null state means "nothing applied yet"
 * (the store's state slot was never populated / a refusal never landed a
 * state): missing controls are NOT dirty, never a throw.
 */
export function isControlDirty(control: string, settings: Settings, state: DeviceState | null): boolean {
  if (!(control in settings)) return false;
  if (!state) return false; // nothing applied yet -> not dirty, never throw
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
export function isNoopApply(control: string, settings: Settings, beforeState: DeviceState | null): boolean {
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
 * M3-C review F2: null-safe via isControlDirty (a null state never throws).
 */
export function isControlDirtyVsApplied(control: string, settings: Settings, state: DeviceState | null, applied: Record<string, unknown>): boolean {
  if (!(control in settings)) return false;
  const wanted = (settings as Record<string, unknown>)[control];
  if (control in applied) return !sameValue(wanted, applied[control]);
  return isControlDirty(control, settings, state);
}

/**
 * B5(a): any-dirty predicate for the floating Apply button against the
 * applied reference + driver state. M3-C review F2: null-safe — a null
 * state (nothing applied yet) is never dirty, never throws.
 */
export function computeDirtyVsApplied(settings: Settings, state: DeviceState | null, applied: Record<string, unknown>): boolean {
  for (const key of Object.keys(settings)) {
    if (isControlDirtyVsApplied(key, settings, state, applied)) return true;
  }
  return false;
}

/**
 * B5(a): scalar variant for the per-card "Unapplied" chips (slider values
 * are numbers; the driver may report none — then it counts as dirty).
 * M3-C review F2: null-safe — a null state with no applied reference is
 * NOT dirty (nothing applied yet), never a throw.
 */
export function isScalarDirtyVsApplied(control: string, value: number, state: DeviceState | null, applied: Record<string, unknown>): boolean {
  if (control in applied) return value !== applied[control];
  if (!state) return false; // nothing applied yet -> not dirty, never throw
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

// ---------------------------------------------------------------------------
// M3-C-F — OC-page refresh signatures (pure, unit-tested)
// ---------------------------------------------------------------------------

/**
 * True when the store's `state` slot changed in a way that matters to the
 * OC cards (an apply from any path / profile load / tray apply). Reference
 * equality short-circuits (the page's own currentState IS the store's
 * state); nested values (gpuLock / fanCurve / vfCurve) are compared by
 * content.
 */
export function ocStateChanged(prev: DeviceState | null, next: DeviceState | null): boolean {
  if (prev === next) return false;
  if (!prev || !next) return true;
  const keys = new Set<keyof DeviceState>([...Object.keys(prev), ...Object.keys(next)] as (keyof DeviceState)[]);
  for (const k of keys) {
    const a = prev[k];
    const b = next[k];
    if (a === b) continue;
    if (typeof a === 'number' || typeof b === 'number') return true;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      if (JSON.stringify(a) !== JSON.stringify(b)) return true;
      continue;
    }
    return true;
  }
  return false;
}

/**
 * True when the capability SURFACE changed (mode toggle / featureset swap) —
 * the OC page must fully re-render then. Content comparison, NOT reference:
 * the page itself re-sets caps after every apply ({ ...caps, waiverAccepted })
 * and a full re-render on that would clobber the applied-reference chips.
 */
export function ocCapsChanged(prev: Capabilities | null, next: Capabilities | null): boolean {
  if (prev === next) return false;
  if (!prev || !next) return true;
  return JSON.stringify(prev.ranges) !== JSON.stringify(next.ranges)
    || JSON.stringify(prev.controls) !== JSON.stringify(next.controls)
    || prev.extendedRanges !== next.extendedRanges;
}

// ---------------------------------------------------------------------------
// M4-B — gpuLock editor (pure; mirrors the main-side clamp bounds)
// ---------------------------------------------------------------------------
// The main process clamps the lock pair to these bounds before it reaches
// the driver (src/main/backend/units.js clampGpuLock). The renderer mirrors
// them ONLY for honest toasts when no read-back envelope exists — main stays
// the authoritative gate.

/** Renderer mirror of units.js GPU_LOCK_VOLT_MAX_V (the absolute VF-point
 *  ceiling; 0 = "don't touch voltage"). */
export const GPU_LOCK_VOLT_MAX_V = 1.5;
/** Renderer mirror of units.js GPU_LOCK_FREQ_MAX_MHZ. */
export const GPU_LOCK_FREQ_MAX_MHZ = 5000;

/**
 * M4-B step-5 F3: parse the gpuLock editor inputs. Empty / whitespace-only
 * fields are rejected BEFORE numeric conversion — `Number('') === 0` and the
 * 0 V / 0 MHz pair is the legal UNLOCK, so a cleared field (or a number
 * input's empty-value state after an invalid entry) must never silently
 * unlock the GPU. Non-finite conversions are rejected too.
 */
export function parseGpuLockInput(
  voltageText: string,
  freqText: string,
): { ok: true; pair: { voltageV: number; freqMhz: number } } | { ok: false } {
  const v = voltageText.trim();
  const f = freqText.trim();
  if (v === '' || f === '') return { ok: false };
  const voltageV = Number(v);
  const freqMhz = Number(f);
  if (!Number.isFinite(voltageV) || !Number.isFinite(freqMhz)) return { ok: false };
  return { ok: true, pair: { voltageV, freqMhz } };
}

/**
 * M4-B step-5 F4: the pair the gpuLock SUCCESS toast must report. Main
 * clamps the typed pair before the write, so the driver received the
 * CLAMPED values — the toast must show the read-back pair when the fresh
 * envelope carried one (honesty: toast == the 'Applied:' line), else the
 * locally clamped pair (same bounds as main's clampGpuLock) so a
 * null/degraded envelope still cannot re-print an out-of-bounds typed
 * value.
 */
export function gpuLockToastPair(
  typed: { voltageV: number; freqMhz: number },
  freshLock: { voltageV: number; freqMhz: number } | null | undefined,
): { voltageV: number; freqMhz: number } {
  if (freshLock) return freshLock;
  return {
    voltageV: Math.min(Math.max(0, typed.voltageV), GPU_LOCK_VOLT_MAX_V),
    freqMhz: Math.min(Math.max(0, typed.freqMhz), GPU_LOCK_FREQ_MAX_MHZ),
  };
}
