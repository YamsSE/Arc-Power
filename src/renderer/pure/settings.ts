// Arc Power - apply-settings payload validation + building (pure, DOM-free).
//
// Mirrors the main-process contract (src/main/ipc-core.js sanitizeSettings):
// keys must be CONTROLS, scalar values finite numbers, gpuLock a well-formed
// pair, vfCurve/fanCurve well-formed arrays. The main process is the
// authoritative gate; this module keeps the UI honest before it ever sends a
// payload, and builds the payload from slider state.

import type { Capabilities, DeviceState, FanMode, LockRange, RangeInfo, Settings } from '../types.ts';
import { MAX_CURVE_POINTS } from './curve.ts';
import { A770_PCI_DEVICE_ID, deviceLimitsOf } from './device-limits.ts';

// F3 PT clamp (M2C-A): the driver setter refuses temp limits above 90 C
// (0x44000005). The exposed max is pinned here on top of the backend clamp
// for Stock mode. M2C-C/M46: Advanced mode may display the documented 115 C
// target even when the bundled 2023 runtime is unavailable; the apply gate,
// not this display clamp, owns that capability refusal.
export const TEMP_LIMIT_MAX_C = 90;
// M3-C-D + M21: the V1 write-side PL range max (old-igcl.js
// EXTENDED_PL_RANGE) - the bundled 2023 runtime's ctlOverclockPowerLimitSet
// refuses above 315 W (0x44000004 - live-verified 2026-08-06). The V1 write
// must NEVER receive a >315 value (it would silent-clamp to 315 and report
// ok:true). M21: the EXPOSED ceiling moved to SYSMAN_PL_MAX_W (375) - the
// >315 W range applies through the sysman pair, never this setter.
export const EXTENDED_PL_MAX_W = 315;
// M21: the A770 advanced-mode PL ceiling - the physical budget (2x8-pin
// 300 W + slot 75 W). Live-verified 2026-08-15 (elevated, this box): the
// sysman pair (zesPowerSetLimits, sustainedW + burstW in ONE call) accepts
// + stores consistent PL1=PL2 up to 4095 W (12-bit field) and ALL THREE
// interfaces (sysman ze, bundled-2023 IGCL, DriverStore getCurrentSettings)
// read the written value back - while the V1 setter refuses >315 and the
// V2 setter refuses >252. So the >315 W range applies through the EXISTING
// sysman companion mechanism (runSysmanCompanion) as the PRIMARY write.
export const SYSMAN_PL_MAX_W = 375;
export const EXTENDED_TL_MAX_C = 115;
// The DriverStore-runtime clamps: applies above these route to the bundled
// 2023 runtime and need the extended-range confirm dialog.
export const STD_PL_MAX_W = 252;
export const STD_TL_MAX_C = 90;
// M15 (F4): the EXPOSED voltage-offset ceiling (V). Live probe evidence
// (2026-08-11, pipeline/live-volt-max-probe.mjs, this machine): the IGCL
// props report gpuVoltageOffset min 0, max 0.234, step 0.005, units V; the
// RAW set ctlOverclockGpuMaxVoltageOffsetSetV2(0.234) -> SUCCESS with
// read-back 0.234, while 0.235 is refused with 0x44000002
// (VOLTAGE_OUTSIDE_RANGE). So 0.234 V IS the driver's real acceptance
// ceiling - the props may under-report the grid-aligned 0.230 (the last
// 0.005-multiple below 0.234), which is exactly the user's report. The
// exposed max is pinned here on top of the backend clamp so the slider
// always offers the real ceiling (the TEMP_LIMIT_MAX_C duplication
// pattern). M15 (F4-fix): the STEP is pinned to VOLT_OFFSET_STEP_V too -
// the driver's 0.005 step puts the 0.234 ceiling OFF-GRID (the slider
// maxed at 0.230); the 0.001 step lets the slider reach + display the real
// ceiling.
export const VOLT_OFFSET_MAX_V = 0.234;
export const VOLT_OFFSET_STEP_V = 0.001;


/**
 * Clamp the exposed range for tempLimitC to TEMP_LIMIT_MAX_C (F3). Other
 * controls pass through untouched. Backend capabilities are already capped,
 * but a stale cache or a future driver props drift must not widen the slider.
 * M2C-C: when the device reports extended ranges, the temp slider may go up
 * to 115 C (the backend range already says so - pass it through).
 * M2D: the W/C pins apply ONLY to canonical-unit ranges - percent-unit
 * featuresets (Battlemage mock: volt/PL/TL as %) are not DriverStore W/C
 * limits and must pass through untouched.
 * M15 (F4): gpuVoltOffsetV gains the same treatment as a CEILING PIN - a
 * V-unit range is pinned to VOLT_OFFSET_MAX_V in BOTH directions (a driver
 * reporting the grid-aligned 0.230 is raised to the real 0.234 ceiling; one
 * drifting above 0.234 is clamped back). When the max is ALREADY 0.234 the
 * SAME object is returned (the pass-through identity pins stay green);
 * percent-unit ranges (Battlemage) pass through untouched.
 * M15 (F4-fix): the STEP is pinned to VOLT_OFFSET_STEP_V (0.001) with the
 * max - the driver's 0.005 step puts 0.234 OFF-GRID, so the slider would
 * max at 0.230; the finer step makes the real ceiling reachable + readable.
 * M17c: the M15 volt pin becomes A770-SCOPED (probe evidence: 0.235 refused
 * on THIS driver - the ceiling is card-specific). Keyed on caps.pciDeviceId:
 * the A770 (0x56A0) exposes max = min(degraded ceiling, 0.234) - the pin
 * NEVER RAISES a value (a session refused-ceiling store degrade below 0.234
 *  is preserved); other V-unit cards (the A750's 0.288 driver props - the
 *  2026-08-12 probe: props max 0.288 V step 0.005) keep
 * their driver props untouched - the global 0.234 clamp is gone. The step
 * stays pinned to 0.001 on the A770 (the 0.234 ceiling is reachable). A
 * call WITHOUT the caps key keeps the legacy M15 both-directions behavior
 * (the pre-M17c pins - the product call sites always pass caps via
 * cardSliderRange).
 * M17g (the global 0.001 V step - the user's fix): the STEP pin becomes
 * GLOBAL for V-unit ranges - EVERY V-unit device's gpuVoltOffsetV range
 * exposes step 0.001 (the driver's 0.005 grid puts the real ceiling
 * off-grid on every card) while the 0.234 MAX stays A770-scoped (the M15
 * probe evidence; other cards keep their driver maxes).
 */
export function clampExposedRange(range: RangeInfo | undefined, key: string, caps?: Capabilities): RangeInfo | undefined {
  if (!range) return range;
  // M46: Advanced display ranges are mode-selected, not proof that the
  // bundled 2023 runtime loaded. The main backend intentionally exposes the
  // documented 375 W / 115 C targets in Advanced even when that runtime's
  // capability probe is unavailable; the apply gate refuses only the values
  // that require the unavailable runtime. Keep the legacy flag-only behavior
  // for older capability payloads that do not carry ocMode.
  const advancedDisplay = caps?.ocMode === 'advanced'
    || (caps?.ocMode === undefined && caps?.extendedRanges === true);
  if (key === 'powerLimitW' && range.units === 'W' && !advancedDisplay && range.max > STD_PL_MAX_W) {
    return { ...range, max: STD_PL_MAX_W, default: Math.min(range.default, STD_PL_MAX_W) };
  }
  if (key === 'tempLimitC' && range.units === 'C' && !advancedDisplay && range.max > TEMP_LIMIT_MAX_C) {
    return { ...range, max: TEMP_LIMIT_MAX_C, default: Math.min(range.default, TEMP_LIMIT_MAX_C) };
  }
  if (key === 'gpuVoltOffsetV' && range.units === 'V') {
    const deviceId = caps?.pciDeviceId;
    if (deviceId === A770_PCI_DEVICE_ID) {
      // M17c: the A770-scoped pin - max = min(degraded ceiling, 0.234),
      // NEVER a raise (a session-store degrade below 0.234 is preserved);
      // the step is pinned to 0.001 so the 0.234 ceiling is reachable.
      if (range.max > VOLT_OFFSET_MAX_V || range.step !== VOLT_OFFSET_STEP_V) {
        return { ...range, max: Math.min(range.max, VOLT_OFFSET_MAX_V), step: VOLT_OFFSET_STEP_V };
      }
      return range; // already legal - the pass-through identity pins stay green
    }
    if (deviceId === undefined || deviceId === null) {
      // Legacy M15 (no caps key / an old payload without pciDeviceId): retain
      // the positive ceiling/step pin and hide the negative UI half-plane.
      if (range.max !== VOLT_OFFSET_MAX_V || range.step !== VOLT_OFFSET_STEP_V || range.min < 0) {
        return {
          ...range,
          max: VOLT_OFFSET_MAX_V,
          step: VOLT_OFFSET_STEP_V,
          ...(range.min < 0 ? { min: 0 } : {}),
        };
      }
      return range;
    }
    // M17g (the global 0.001 V step - the user's fix): a KNOWN non-A770
    // V-unit device (the A750's 0.288 driver props - the 2026-08-12 probe)
    // keeps its driver MAX untouched, but the STEP is pinned to 0.001 for
    // EVERY V-unit range - the driver's 0.005 grid puts the real ceiling
    // OFF-GRID on every V-unit card, so the slider could never reach the
    // props max (the same hazard the A770 pin fixed). The 0.234 MAX stays
    // A770-scoped (the M15 probe evidence). A step already 0.001 passes
    // through untouched (the pass-through identity pins stay green).
    if (range.step !== VOLT_OFFSET_STEP_V || range.min < 0) {
      return { ...range, step: VOLT_OFFSET_STEP_V, ...(range.min < 0 ? { min: 0 } : {}) };
    }
    return range;
  }
  return range;
}

/**
 * M4-B step-5 F1: the slider range ONE OC card exposes - the raw capability
 * range passed through clampExposedRange. buildCard AND refreshCard must
 * derive from the SAME clamped range: the refresh path used to read the raw
 * range directly, so after any apply the slider min/max/step were rewritten
 * from the UNCLAMPED caps - a stale cache or a future driver props drift
 * would have silently widened the slider, removing the UI half of the M2C-A
 * F3 guard. Undefined (unknown control / no caps) -> undefined; the callers
 * guard before use.
 * M17c: the CAPS KEY always flows through here (the tuning.ts call sites
 * pass the full caps) - the device-scoped A770 volt pin keys on
 * caps.pciDeviceId, so the A750's driver props (0.288 - the 2026-08-12
 * probe) pass through and the A770 ceiling stays 0.234.
 */
export function cardSliderRange(caps: Capabilities | null | undefined, key: string): RangeInfo | undefined {
  return clampExposedRange(caps?.ranges[key], key, caps ?? undefined);
}

/**
 * M4J clarification (Alchemist scope): the ADVANCED SECTION renders ONLY on
 * devices whose supportedControls carry vramFreqOffset (the VRAM-OC control -
 * the Battlemage-generation surface): b580 = the VRAM clock editor;
 * a770/arc-igpu/pro-b50 = NO section (the gpuLock editor + the
 * vfCurve/vramVoltOffset rows are gone per the user - profiles can still
 * apply those values via the state machinery, documented). The OC-mode
 * column (Stock/Advanced pill) is NOT keyed on this helper - it renders on
 * EVERY device as in 1.0.3 (the mode + the advanced confirm + the extended
 * ranges work on Alchemist as before). Pure + unit-pinned.
 */
export function advancedUiVisible(caps: Capabilities | null | undefined): boolean {
  return caps?.controls?.vramFreqOffset === true;
}

/**
 * M2C-C: true when the pending settings contain an extended-range value
 * (PL > 252 W or TL > 90 C) - the apply must pass the extended-range confirm
 * dialog first (honest warning: beyond Intel's standard limit; card/driver
 * dependent; the Acer BiFrost profile used 300 W).
 * M2D: the extended-range concept is W/C-only - when the device caps are
 * known, percent-unit ranges (Battlemage mock: volt/PL/TL as %) never count
 * as extended (e.g. a 100% temp limit is not 100 C).
 * M17c/M17d: the thresholds feed from the SAME device-scoped limits table
 * the main-side gate uses (requiresExtendedRangeConfirm feeds from the
 * same table - round-2 S8): a LISTED card's confirm threshold = its listed
 * STOCK row's max (the a750 ASRock's 216 W PL / the 90 C TL caps), the
 * default 252/90 for unlisted cards. M17d (round-1 S1): PINNED TO THE
 * STOCK SHAPE explicitly - the confirm dialog is about crossing the
 * standard Intel limit, so the STOCK ceiling is the threshold (an advanced
 * apply of 250 W on the A750 still needs the extended-range confirm even
 * though the advanced ceiling is 270 - the default shape selection must
 * not silently flip). Keyed on the caps identity
 * (pciDeviceId/aibVendor/aibModel) - never caps.ranges.
 */
export function requiresExtendedRangeConfirm(settings: Settings, caps?: Capabilities): boolean {
  const plRange = caps?.ranges?.powerLimitW;
  const tlRange = caps?.ranges?.tempLimitC;
  // M17c: the device identity (the caps fields - optional on Capabilities,
  // the limits table accepts them) - never caps.ranges.
  const limits = deviceLimitsOf({
    pciDeviceId: caps?.pciDeviceId ?? null,
    aibVendor: caps?.aibVendor ?? null,
    aibModel: caps?.aibModel ?? null,
  });
  const plMax = limits?.powerLimitW?.max ?? STD_PL_MAX_W;
  const tlMax = limits?.tempLimitC?.max ?? STD_TL_MAX_C;
  return (typeof settings.powerLimitW === 'number' && settings.powerLimitW > plMax && (!plRange || plRange.units === 'W'))
    || (typeof settings.tempLimitC === 'number' && settings.tempLimitC > tlMax && (!tlRange || tlRange.units === 'C'));
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
export interface ScalarSettingsOptions {
  /** V-unit negative driver values are intentionally hidden from the UI. */
  hiddenNegativeControls?: ReadonlySet<string>;
}

export function buildScalarSettings(values: Record<string, number>, options: ScalarSettingsOptions = {}): Settings {
  const out: Settings = {};
  for (const [key, v] of Object.entries(values)) {
    if (options.hiddenNegativeControls?.has(key) && v === 0) continue;
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
 * `state` (a missing driver value counts as dirty - the UI must surface an
 * unapplied state it cannot verify).
 * M3-C review F2: NULL-SAFE - a null state means "nothing applied yet"
 * (the store's state slot was never populated / a refusal never landed a
 * state): missing controls are NOT dirty, never a throw.
 */
export function isControlDirty(control: string, settings: Settings, state: DeviceState | null, hiddenNegativeControls?: ReadonlySet<string>): boolean {
  if (!(control in settings)) return false;
  if (!state) return false; // nothing applied yet -> not dirty, never throw
  const wanted = (settings as Record<string, unknown>)[control];
  const driver = (state as unknown as Record<string, unknown>)[control];
  if (driver === null || driver === undefined) return true;
  if (hiddenNegativeControls?.has(control) && control === 'gpuVoltOffsetV'
    && wanted === 0 && typeof driver === 'number' && driver < 0) return false;
  if (typeof wanted === 'number') return wanted !== driver;
  if (typeof wanted === 'string') return wanted !== driver;
  if (control === 'gpuLock') return !samePair(wanted as { voltageV: number; freqMhz: number }, driver as { voltageV: number; freqMhz: number });
  return !samePointArray(wanted, driver); // fanCurve / vfCurve
}

/**
 * No-op apply predicate (M2b-B toast suppression): true when the requested
 * value for `control` equals the driver's value BEFORE the apply - i.e. the
 * apply changed nothing for that control, so a success toast would be noise.
 * Call with the pre-apply state snapshot. (M2C-B B5(b): the no-op comparison
 * STAYS against the driver read-back - the silent-success rule survives the
 * applied-reference change.)
 */
export function isNoopApply(control: string, settings: Settings, beforeState: DeviceState | null): boolean {
  return !isControlDirty(control, settings, beforeState);
}

// ---------------------------------------------------------------------------
// M2C-B B5 - applied-reference dirty detection (chips + floating Apply)
// ---------------------------------------------------------------------------
//
// Two separate references, deliberately NOT merged:
//   (a) the dirty reference for the per-card chips + the per-card Apply
//       button (the M9 chip state machine) AND the floating Apply button:
//       per-`result.ok` control it becomes the APPLIED value, so the chip
//       clears and the button hides even while the driver read-back lags
//       (the mock/A770 read-back can trail the write);
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
 * A control in `applied` is judged against the applied value alone - the
 * lagging driver read-back cannot re-dirty a chip that just applied.
 * M3-C review F2: null-safe via isControlDirty (a null state never throws).
 */
export function isControlDirtyVsApplied(control: string, settings: Settings, state: DeviceState | null, applied: Record<string, unknown>, hiddenNegativeControls?: ReadonlySet<string>): boolean {
  if (!(control in settings)) return false;
  const wanted = (settings as Record<string, unknown>)[control];
  if (control in applied) return !sameValue(wanted, applied[control]);
  return isControlDirty(control, settings, state, hiddenNegativeControls);
}

/**
 * B5(a): any-dirty predicate for the floating Apply button against the
 * applied reference + driver state. M3-C review F2: null-safe - a null
 * state (nothing applied yet) is never dirty, never throws.
 */
export function computeDirtyVsApplied(settings: Settings, state: DeviceState | null, applied: Record<string, unknown>, hiddenNegativeControls?: ReadonlySet<string>): boolean {
  for (const key of Object.keys(settings)) {
    if (isControlDirtyVsApplied(key, settings, state, applied, hiddenNegativeControls)) return true;
  }
  return false;
}

/**
 * B5(a): scalar variant for the per-card chips (slider values are numbers;
 * the driver may report none - then it counts as dirty).
 * M3-C review F2: null-safe - a null state with no applied reference is
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
 * mark and the "applied to the GPU" wording are gated on `result.ok` - a
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
      : `"${name}" matches the current GPU state - nothing changed.`,
  };
}

// ---------------------------------------------------------------------------
// M3-C-F - OC-page refresh signatures (pure, unit-tested)
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
 * True when the capability SURFACE changed (mode toggle / featureset swap) -
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

/**
 * M24 (Part B): the FAN-STATE SIGNATURE - a stable string over the store
 * state's fan fields (fanMode / fanCurve / fixedFanPct). The Tuning page's
 * fan view re-renders its editor when the signature CHANGES (an external
 * push - the advanced-overlay panel's fan apply - changed the store's fan
 * fields), and stays untouched when it is equal (the user's own apply, the
 * telemetry ticks). Absent fields degrade to null in the JSON (a state
 * without a field and a state with an explicit null are the SAME
 * signature - never a spurious re-render).
 */
export function fanStateSignature(state: DeviceState | null | undefined): string {
  if (!state) return 'null';
  return JSON.stringify({
    fanMode: state.fanMode ?? null,
    fanCurve: state.fanCurve ?? null,
    fixedFanPct: state.fixedFanPct ?? null,
  });
}

// ---------------------------------------------------------------------------
// M4-B/M17d - gpuLock card (pure; mirrors the main-side clamp bounds)
// ---------------------------------------------------------------------------
// The main process clamps the lock pair to these bounds before it reaches
// the driver (src/main/backend/units.js clampGpuLock). The renderer mirrors
// them ONLY for honest toasts when no read-back envelope exists - main stays
// the authoritative gate. The helpers were REMOVED with the M4-J editor and
// RETURN with the M17d standalone Fixed Clock / Voltage Lock card (Run D).

/** Renderer mirror of units.js GPU_LOCK_VOLT_MAX_V (the absolute VF-point
 *  ceiling; 0 = "don't touch voltage"). */
export const GPU_LOCK_VOLT_MAX_V = 1.5;
/** Renderer mirror of units.js GPU_LOCK_FREQ_MAX_MHZ. */
export const GPU_LOCK_FREQ_MAX_MHZ = 5000;

/**
 * M17e: the renderer mirror of the main-side clampGpuLock (units.js) - the
 * SAME (0,0)-bypass + per-side zero pass-through + lockRange-aware
 * semantics, so the UI's local clamp never disagrees with what main will
 * do:
 *   - the (0,0) unlock pair ALWAYS passes unclamped (round-1 S2: a positive
 *     voltMin must never clamp the unlock);
 *   - the PER-SIDE zero pass-through (round-2 N4): a 0 side means "don't
 *     touch" that dimension - a (0 V, 2400 MHz) pair with a positive
 *     voltMin stays 0 V and a (0.9 V, 0 MHz) pair with a positive freqMin
 *     stays 0 MHz (a positive min must never resurrect a "don't touch"
 *     side);
 *   - a non-zero pair clamps to [max(0, voltMin ?? 0), voltMax ?? 1.5] V /
 *     [freqMin ?? 0, freqMax ?? 5000] MHz (the documented fallback fills
 *     the absent range sides).
 * Main stays the authoritative gate (the backend applyLock passes its
 * caps.lockRange); this mirror keeps the card/toast honest.
 * @param lock the typed pair (canonical volts)
 * @param lockRange the caps.lockRange (optional - the documented fallback
 *   when absent)
 */
export function clampGpuLock(
  lock: { voltageV: number; freqMhz: number },
  lockRange?: Partial<LockRange> | null,
): { voltageV: number; freqMhz: number } {
  if (lock.voltageV === 0 && lock.freqMhz === 0) {
    return { voltageV: 0, freqMhz: 0 }; // the (0,0) reset pair bypass (S2)
  }
  const range = lockRange ?? {};
  const voltMin = Math.max(0, Number.isFinite(range.voltMin) ? (range.voltMin as number) : 0);
  const voltMax = Number.isFinite(range.voltMax) ? (range.voltMax as number) : GPU_LOCK_VOLT_MAX_V;
  const freqMin = Math.max(0, Number.isFinite(range.freqMin) ? (range.freqMin as number) : 0);
  const freqMax = Number.isFinite(range.freqMax) ? (range.freqMax as number) : GPU_LOCK_FREQ_MAX_MHZ;
  return {
    voltageV: lock.voltageV === 0 ? 0 : Math.min(Math.max(voltMin, lock.voltageV), voltMax),
    freqMhz: lock.freqMhz === 0 ? 0 : Math.min(Math.max(freqMin, lock.freqMhz), freqMax),
  };
}

/**
 * M17f (round-5): format the lock editor's RANGE LINE - the per-GPU lock
 * bounds the card will enforce, resolved EXACTLY like clampGpuLock (the
 * same per-side DOCUMENTED fallback fills the absent sides: voltMax ->
 * GPU_LOCK_VOLT_MAX_V, freqMax -> GPU_LOCK_FREQ_MAX_MHZ, mins -> 0; the
 * negative mins floor at 0). The caps.lockRange live values render when
 * present; the documented fallback text when absent (the same fallback the
 * clamp uses - the display never claims a range the clamp would not
 * enforce); the honest 'Range: -' when no range RESOLVES (a non-positive
 * max or an inverted min>max - the clamp would clamp into nonsense, so no
 * range is claimed).
 */
export function formatLockRange(lockRange?: Partial<LockRange> | null): string {
  const range = lockRange ?? {};
  const voltMin = Math.max(0, Number.isFinite(range.voltMin) ? (range.voltMin as number) : 0);
  const voltMax = Number.isFinite(range.voltMax) ? (range.voltMax as number) : GPU_LOCK_VOLT_MAX_V;
  const freqMin = Math.max(0, Number.isFinite(range.freqMin) ? (range.freqMin as number) : 0);
  const freqMax = Number.isFinite(range.freqMax) ? (range.freqMax as number) : GPU_LOCK_FREQ_MAX_MHZ;
  if (voltMin > voltMax || freqMin > freqMax || voltMax <= 0 || freqMax <= 0) {
    return 'Range: -';
  }
  return `Range: ${voltMin} - ${voltMax} V / ${freqMin} - ${freqMax} MHz`;
}

/**
 * M4-B step-5 F3: parse the gpuLock editor inputs. Empty / whitespace-only
 * fields are rejected BEFORE numeric conversion - `Number('') === 0` and the
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
 * M17d (Run D): the gpuLock card read-out / toast formatting - the pair the
 * DRIVER holds, formatted honestly. The (0,0) pair IS the dynamic/unlocked
 * convention; any other pair renders the absolute VF values.
 */
export function formatLockPair(pair: { voltageV: number; freqMhz: number } | null | undefined): string {
  if (!pair) return 'Dynamic (unlocked)';
  if (pair.voltageV === 0 && pair.freqMhz === 0) return 'Dynamic (unlocked)';
  return `${pair.voltageV} V / ${pair.freqMhz} MHz`;
}

/**
 * M4-B step-5 F4: the pair the gpuLock SUCCESS toast must report. Main
 * clamps the typed pair before the write, so the driver received the
 * CLAMPED values - the toast must show the read-back pair when the fresh
 * envelope carried one (honesty: toast == the 'Applied:' line), else the
 * locally clamped pair (the same bounds as main's clampGpuLock - the
 * lockRange-aware mirror, M17e) so a null/degraded envelope still cannot
 * re-print an out-of-bounds typed value.
 */
export function gpuLockToastPair(
  typed: { voltageV: number; freqMhz: number },
  freshLock: { voltageV: number; freqMhz: number } | null | undefined,
  lockRange?: Partial<LockRange> | null,
): { voltageV: number; freqMhz: number } {
  if (freshLock) return freshLock;
  return clampGpuLock(typed, lockRange);
}
