// Arc Power - M2C-C per-control runtime routing (the shared apply core).
//
// One apply can need BOTH runtimes: values within the DriverStore range
// (PL <= 252 W, TL <= 90 C) go through the DriverStore runtime (the regular
// IOCBackend); PL > 252 / TL > 90 go through the bundled 2023 IGCL runtime
// (old-igcl.js), which the DriverStore runtime clamps client-side. Mixed
// applies split per control.
//
// The momentary-lie lesson applies to BOTH paths: a write that returns
// SUCCESS but whose read-back mismatches may be a non-persisting write
// (non-elevated) or just a lagging read-back (elevated). Every mismatch is
// re-read ONCE after ~400 ms; a match on the delayed read is a real
// persisted write, anything else is an honest per-control failure.
//
// Electron-free - shared by the UI apply path, the tray/boot applies and
// the elevated apply-worker.

import { applyOnce } from './apply-once.js';
import { clampAndSnap, nearlyEqual } from './backend/units.js';
import { EXTENDED_PL_MAX_W, EXTENDED_TL_MAX_C } from './old-igcl.js';
// M17c: the per-device limits table (the listed rows + the default row).
// The renderer TS imports fine under the packaged Electron (Node 22.21
// type stripping); the pure module carries no runtime TS-only features.
import { deviceLimitsOf } from '../renderer/pure/device-limits.ts';

export const STD_PL_MAX_W = 252;
export const STD_TL_MAX_C = 90;

/**
 * M17c: resolve the DEVICE-SCOPED gate thresholds from the pure limits
 * table. A LISTED card's thresholds come from its LISTED row; an UNLISTED
 * card gets the DEFAULT row (252/90 stock, 315/115 advanced - today's pins
 * exactly). Null/garbage identity -> the default row. THE
 * M3-C-E PROHIBITION: the thresholds come from the PURE TABLE, never from
 * caps.ranges (a caps-keyed gate would silently clamp on the worker side).
 * M17d (round-1 S1): the thresholds consume the SAME STOCK/ADVANCED SPLIT
 * as the finalize consumers - `advanced` selects the ADVANCED shape (the
 * per-card KMD ceilings: A770 375/115, A750 270/115 - the A750 TL
 * probe-verified 2026-08-12; the round-3-N3 rule
 * FLIPS to "listed-row advanced ceiling = the app-verified KMD ceiling"),
 * the stock shape otherwise (the per-AIB maxes + the TL 90 caps). A
 * listed-card advanced apply of e.g. 250 W on the A750 now PASSES the
 * advanced gate (the 270 ceiling) instead of refusing at the stock 216.
 * @param {unknown} limitsKey the device identity - the caps object (the
 *   pciDeviceId/aibVendor/aibModel fields) or null (the default row)
 * @param {boolean} advanced whether the ADVANCED (extended) ceiling applies
 * @returns {{ plMax: number, tlMax: number }}
 */
export function deviceGateThresholds(limitsKey, advanced) {
  const identity = limitsKey && typeof limitsKey === 'object'
    ? {
        pciDeviceId: limitsKey.pciDeviceId ?? null,
        aibVendor: limitsKey.aibVendor ?? null,
        aibModel: limitsKey.aibModel ?? null,
      }
    : null;
  const limits = deviceLimitsOf(identity, { advanced: advanced === true });
  if (!limits || !limits.listed) {
    return advanced
      ? { plMax: EXTENDED_PL_MAX_W, tlMax: EXTENDED_TL_MAX_C }
      : { plMax: STD_PL_MAX_W, tlMax: STD_TL_MAX_C };
  }
  return {
    plMax: typeof limits.powerLimitW?.max === 'number' ? limits.powerLimitW.max
      : (advanced ? EXTENDED_PL_MAX_W : STD_PL_MAX_W),
    tlMax: typeof limits.tempLimitC?.max === 'number' ? limits.tempLimitC.max
      : (advanced ? EXTENDED_TL_MAX_C : STD_TL_MAX_C),
  };
}

// ---------------------------------------------------------------------------
// M3-C-E - the OC-mode gate (STOCK | ADVANCED), ONE shared pure function.
//
// The gate is an explicit PRE-CLAMP REFUSAL, never a clamp, and it is
// independent of the caps cache (the worker's own backend always reports
// extendedRanges - a caps-keyed gate there would silently clamp, exactly
// the forbidden behavior). It is keyed on the persisted ocMode + the STD
// limits (unit-aware since M4-E: percent-unit ranges are never extended
// values - see ocModeRefusal) and is called BEFORE every clamp in:
//   - ipc-core 'apply-settings'
//   - applyProfile / apply-on-boot (boot + tray)
//   - apply-worker (the request file carries ocMode)
//
// M3-C step-5 F1: a SECOND refusal gate sits after it - the capability
// refusal (extendedUnavailableRefusal). The mode gate ALLOWS PL > 252 /
// TL > 90 in advanced mode, but the value is only writable through the
// bundled 2023 runtime; when that runtime cannot load on the current
// driver (the future-driver degradation EXTENDED_UNAVAILABLE_MSG exists
// for), the clamp layer would silently cap to 252 W / 90 C and report
// ok:true - a false success claim. The capability refusal keys on
// caps.extendedRanges (NOT on the mode - a mode-keyed version would be
// exactly the forbidden caps-keyed gate): the capability probe is
// identical on both sides of the worker boundary (the worker's backend
// derives caps from the same isCapable probe), so it is honest in every
// process. It runs in all four apply paths AFTER getCapabilities and
// BEFORE any clamp:
//   - ipc-core 'apply-settings'
//   - apply-worker
//   - applyProfile / apply-on-boot (boot + tray)
//   - executeApply (apply-routing - the safety net for direct callers)
// ---------------------------------------------------------------------------

export const OC_MODE_STOCK = 'stock';
export const OC_MODE_ADVANCED = 'advanced';
export const OC_MODES = [OC_MODE_STOCK, OC_MODE_ADVANCED];

/** Stock-mode refusal: the value is beyond Intel's standard limit. */
export const OC_MODE_REFUSAL_MSG =
  'This value is beyond the standard Intel limit and Advanced OC Mode is off. Enable Advanced OC Mode to apply extended power/temperature limits. Nothing was changed.';
/** Advanced-mode refusal: above the extended ceiling (never clamps). */
export const OC_CEILING_REFUSAL_MSG =
  'This value is above the maximum the GPU can accept. Nothing was changed.';

/**
 * The OC-mode gate. Returns null when the settings are acceptable in the
 * current mode, else the refusal descriptor { mode, controls, message }.
 * - stock:    any PL > STD_PL_MAX_W (252) or TL > STD_TL_MAX_C (90) refuses
 *             with the mode message;
 * - advanced: PL/TL up to the EXTENDED ceiling are allowed; M21: the
 *             advanced PL ceiling is the sysman-primary 375 W (the
 *             device-scoped row - A770 375 / A750 270 / 315 unlisted - the
 *             >315 W range applies through the sysman pair mechanism as the
 *             PRIMARY write, never a silent clamp); TL up to 115 C;
 *             values above the ceiling refuse with the ceiling message - NEVER
 *             clamped (an above-ceiling write would be silently capped by
 *             the clamp layer, voiding the 400 W probe).
 * M4-E: unit-aware like splitByRuntime / extendedUnavailableRefusal - when
 * the capability ranges are known and a control's units are NOT W/C
 * (percent-unit Battlemage mock: volt/PL/TL as %), the W/C thresholds do
 * not apply at all: percent units have no extended concept (their range max
 * IS the ceiling, and the clamp layer handles out-of-range values), so
 * e.g. a 100% temp limit is never "beyond the standard Intel limit" and a
 * stock-mode percent apply is never refused. The units probe is a device
 * property identical on both sides of the worker boundary (never the
 * extendedRanges flag - the caps-keyed mode gate the plan forbids stays
 * forbidden). Unknown ranges keep the historical threshold behavior.
 * M17c/M17d (round-2 S8 + round-1 S1): the thresholds become DEVICE-SCOPED
 * from the pure limits table (`limitsKey` - the caps object; the call
 * sites always pass the caps they already read) and consume the
 * STOCK/ADVANCED SPLIT: a LISTED card's STOCK thresholds come from its
 * listed STOCK row (per-AIB PL 216/228 W + the probe-pinned Acer 216 W -
 * the 2026-08-12 verdict, the 235 BiFrost documented claim refuted as a
 * stock value on the Acer card; TL 90 C - a profile/boot/
 * tray apply of a value in (216, 315] on a listed card must REFUSE with
 * the ceiling class in stock mode, never silently clamp down to the card's
 * ceiling via caps.ranges); the ADVANCED thresholds are the per-card KMD
 * ceilings (A770 375/115 - M21: the 375 is the sysman-primary ceiling,
 * the 315 is the V1 write range; A750 270/115 - probe-verified 2026-08-12; the
 * round-3-N3 rule FLIPS: a listed-card advanced apply up to the KMD
 * ceiling SUCCEEDS). The DEFAULT
 * row (252/315) is only for unlisted cards. PRE-CLAMP and non-caps-keyed:
 * the thresholds come from the pure table, never caps.ranges (the M3-C-E
 * prohibition).
 * @param {string} ocMode 'stock' | 'advanced'
 * @param {Record<string, unknown>} settings
 * @param {Record<string, { units?: string }>} [ranges]
 * @param {{ pciDeviceId?: string|null, aibVendor?: string|null, aibModel?: string|null }|null} [limitsKey]
 *   M17c: the device identity (the caps object - the device-limits table
 *   keys on it); null/absent -> the default row (today's thresholds).
 * @returns {{ mode: string, controls: string[], message: string } | null}
 */
export function ocModeRefusal(ocMode, settings, ranges = null, limitsKey = null) {
  if (!settings || typeof settings !== 'object') return null;
  const mode = ocMode === OC_MODE_ADVANCED ? OC_MODE_ADVANCED : OC_MODE_STOCK;
  const { plMax, tlMax } = deviceGateThresholds(limitsKey, mode === OC_MODE_ADVANCED);
  const isWcUnits = (key) => {
    const units = ranges?.[key]?.units ?? null;
    if (units === null || units === undefined) return true; // unknown -> historical behavior
    return key === 'powerLimitW' ? units === 'W' : units === 'C';
  };
  const over = [];
  if (typeof settings.powerLimitW === 'number' && settings.powerLimitW > plMax && isWcUnits('powerLimitW')) over.push('powerLimitW');
  if (typeof settings.tempLimitC === 'number' && settings.tempLimitC > tlMax && isWcUnits('tempLimitC')) over.push('tempLimitC');
  if (over.length === 0) return null;
  return {
    mode,
    controls: over,
    message: mode === OC_MODE_ADVANCED ? OC_CEILING_REFUSAL_MSG : OC_MODE_REFUSAL_MSG,
  };
}

/**
 * Build the per-control failure entries for a gate refusal (the renderer
 * toasts them per control; the message is the mode/ceiling text only).
 * @param {{ controls: string[], message: string }} refusal
 * @returns {Record<string, { ok: boolean, errorCode: string, message: string }>}
 */
export function refusalPerControl(refusal) {
  const perControl = {};
  for (const c of refusal.controls) {
    perControl[c] = { ok: false, errorCode: 'out-of-range', message: refusal.message };
  }
  return perControl;
}

// The per-control failure message when the old runtime cannot load on the
// current driver (future-driver degradation - honest, never a silent cap).
export const EXTENDED_UNAVAILABLE_MSG =
  'extended power/temp limit requires the bundled 2023 IGCL runtime - it failed to load on this driver';

/**
 * M3-C step-5 F1: advanced-mode CAPABILITY refusal - PL > 252 / TL > 90
 * requested while the bundled 2023 runtime is NOT capable on this driver
 * (caps.extendedRanges false). The OC-mode gate allows those values in
 * advanced mode; without this refusal the clamp layer would silently cap
 * them to 252 W / 90 C and report ok:true - a false success claim (and
 * splitByRuntime never sees the value, so EXTENDED_UNAVAILABLE_MSG is
 * unreachable). The check is unit-aware (M2D): percent-unit ranges
 * (Battlemage mock) are never extended values. Keyed on the CAPABILITY,
 * never the mode - the capability probe is identical on both sides of the
 * worker boundary, so this is a capability refusal, not the caps-keyed
 * mode gate the plan forbids.
 * @param {Record<string, unknown>} settings
 * @param {{ extendedRanges?: boolean, ranges?: Record<string, { units?: string }> } | null | undefined} caps
 * @returns {{ controls: string[], message: string } | null}
 */
export function extendedUnavailableRefusal(settings, caps) {
  if (!settings || typeof settings !== 'object') return null;
  if (caps?.extendedRanges === true) return null;
  const ranges = caps?.ranges ?? null;
  const isWcUnits = (key) => {
    const units = ranges?.[key]?.units ?? null;
    if (units === null || units === undefined) return true; // unknown -> historical behavior
    return key === 'powerLimitW' ? units === 'W' : units === 'C';
  };
  const over = [];
  if (typeof settings.powerLimitW === 'number' && settings.powerLimitW > STD_PL_MAX_W && isWcUnits('powerLimitW')) over.push('powerLimitW');
  if (typeof settings.tempLimitC === 'number' && settings.tempLimitC > STD_TL_MAX_C && isWcUnits('tempLimitC')) over.push('tempLimitC');
  if (over.length === 0) return null;
  return { controls: over, message: EXTENDED_UNAVAILABLE_MSG };
}

/**
 * M17d (Run D - the V1-call pin): the W/C-unit control keys present in a
 * settings payload - the controls the mode-based split routes through the
 * bundled 2023 runtime (V1) when the apply runs in ADVANCED mode (a profile
 * apply is advanced-gated, so ITS W/C values route V1 REGARDLESS of value).
 * Unit-aware like the split (M2D): percent-unit ranges (Battlemage) are
 * never V1-routed controls; unknown ranges keep the historical behavior.
 * Used by the PROFILE-apply capability refusal - on a driver where the
 * bundled 2023 runtime cannot load, an in-range profile W/C value must
 * REFUSE with EXTENDED_UNAVAILABLE_MSG (a capability/config refusal, never
 * the defaults-restore fallback - the "silent wipe over a degradation"
 * class), because the split would route it to a runtime that does not
 * exist instead of silently falling through to the V2 setter (which is
 * exactly the fall-through the pin forbids).
 * @param {Record<string, unknown>} settings
 * @param {Record<string, { units?: string }>} [ranges]
 * @returns {string[]}
 */
export function wcUnitControls(settings, ranges = null) {
  if (!settings || typeof settings !== 'object') return [];
  const isWcUnits = (key) => {
    const units = ranges?.[key]?.units ?? null;
    if (units === null || units === undefined) return true; // unknown -> historical behavior
    return key === 'powerLimitW' ? units === 'W' : units === 'C';
  };
  const out = [];
  if (typeof settings.powerLimitW === 'number' && isWcUnits('powerLimitW')) out.push('powerLimitW');
  if (typeof settings.tempLimitC === 'number' && isWcUnits('tempLimitC')) out.push('tempLimitC');
  return out;
}

/**
 * Per-control failure entries for the extended-unavailable refusal - the
 * same 'unsupported' shape the old runtime reports itself (honest, no
 * read-back claim).
 * @param {string[]} controls
 * @returns {Record<string, { ok: boolean, errorCode: string, message: string }>}
 */
export function extendedUnavailablePerControl(controls) {
  const perControl = {};
  for (const c of controls) {
    perControl[c] = { ok: false, errorCode: 'unsupported', message: EXTENDED_UNAVAILABLE_MSG };
  }
  return perControl;
}

/**
 * M4O: the clamp ranges for PROFILE applies - the driver's TRUE limits
 * (the extended W/C maxes, NOT the
 * mode-gated caps.ranges (stock mode caps max at 252 W / 90 C - clamping a
 * profile there would silently reduce a saved 300 W profile to 252 W, the
 * "silent reduction reported as applied" class the codebase forbids).
 *
 * M21 (F3): the W max is DEVICE-SCOPED to the ADVANCED row's ceiling
 * (deviceLimitsOf(limitsKey, { advanced: true }) -> 375 W on the A770 /
 * 270 W on the A750 / the 315 W default row for unlisted cards) so a 350 W
 * A770 profile passes the clamp and reaches the sysman-primary write
 * instead of a silent 315 W clamp. The M4O contract stays: an above-ceiling
 * (>375 W on the A770) profile still refuses via ocModeRefusal BEFORE this
 * clamp.
 *
 * Overrides ONLY when the range key exists with the matching unit: a
 * W-unit device without a tempLimitC key yields undefined for it (no own
 * keys are added - the conditional spread never invents a key); percent-
 * unit devices (Battlemage) keep their own ranges (their max IS the
 * ceiling and splitByRuntime never routes them to the 2023 runtime).
 * Null-guarded - the helper is exported and standalone-tested.
 * @param {{ ranges?: Record<string, { units?: string }>, pciDeviceId?: string | null, aibVendor?: string | null, aibModel?: string | null } | null | undefined} caps
 * @returns {Record<string, unknown>}
 */
export function extendedRangesFor(caps) {
  const ranges = caps?.ranges ?? null;
  if (!ranges) return {};
  const out = { ...ranges };
  const pl = ranges.powerLimitW;
  if (pl && pl.units === 'W') {
    // M21: the device-scoped ADVANCED ceiling (the caps identity resolves
    // the listed row; an unlisted card keeps the 315 W default row).
    const advanced = deviceLimitsOf({
      pciDeviceId: caps.pciDeviceId ?? null,
      aibVendor: caps.aibVendor ?? null,
      aibModel: caps.aibModel ?? null,
    }, { advanced: true });
    const plMax = typeof advanced?.powerLimitW?.max === 'number'
      ? advanced.powerLimitW.max
      : EXTENDED_PL_MAX_W;
    out.powerLimitW = { ...pl, max: plMax };
  }
  const tl = ranges.tempLimitC;
  if (tl && tl.units === 'C') out.tempLimitC = { ...tl, max: EXTENDED_TL_MAX_C };
  const volt = ranges.gpuVoltOffsetV;
  if (volt && volt.units === 'V') {
    const advanced = deviceLimitsOf({
      pciDeviceId: caps.pciDeviceId ?? null,
      aibVendor: caps.aibVendor ?? null,
      aibModel: caps.aibModel ?? null,
    }, { advanced: true });
    const advancedMin = advanced?.gpuVoltOffsetV?.min;
    if (Number.isFinite(advancedMin)) {
      out.gpuVoltOffsetV = { ...volt, min: advancedMin };
    }
  }
  return out;
}

// The momentary-lie re-read delay (default 400 ms, injectable in tests).
export const DELAYED_VERIFY_MS = 400;

// M19 THE BOUNDED FRESH-SPAWN RETRY (the Acer-tool mechanism): when the
// proxy answers the instant not-ready verdict, the helper was NOT up (the
// boot's warm is fire-and-forget; the request paths never connect). The
// M17o2 live evidence: a FRESH process's ze init ALWAYS succeeds (5/5,
// even 2 s after a write) - the Acer Predator tool applies its profile
// 300/300 instantly by spawning a fresh helper per apply. So the
// companion fires the proxy's warm() (the only spawn+connect path) and
// retries the set within this bound before falling to the V2-clamp.
export const NOT_READY_RETRY_BOUND_MS = 2500;
// The poll cadence of the bounded retry loop (the set answers the instant
// not-ready verdict until the fresh helper's socket + ready line land).
export const NOT_READY_RETRY_POLL_MS = 400;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Split one Settings payload into the DriverStore-runtime part and the
 * extended (2023-runtime) part, per control. Null/absent values are dropped.
 *
 * M2D: the split is unit-aware - the 2023 runtime speaks W/C only. When the
 * capability ranges are known and a control's units are NOT W/C (percent-unit
 * Battlemage mock: volt/PL/TL as %), a numerically large value (e.g. a 100%
 * temp limit) can never be an extended-range request: it goes to the
 * DriverStore runtime like any other percent value. Unknown ranges (no caps
 * available) keep the historical threshold behavior.
 *
 * M17d (Run D - THE V1-CALL PIN, the user directive, ALCHEMIST FAMILY-WIDE):
 * the split becomes MODE-BASED for the W/C controls. In ADVANCED mode the
 * W-unit powerLimitW + the C-unit tempLimitC ALWAYS route to the extended
 * (V1) part - the bundled 2023 runtime's ctlOverclockPowerLimitSet (mW) /
 * ctlOverclockTemperatureLimitSet (C); in STOCK mode they route to the
 * driverstore part (V2 - as today). THE BUG IT FIXES (real-hardware
 * evidence, the 2026-08-12 A750 probe): the threshold-based split routed
 * PL/TL to the extended runtime ONLY when the value > 252 W / 90 C - an
 * ADVANCED apply of e.g. 250 W on the A750 (whose KMD ceiling is 270) fell
 * through to the DriverStore path, whose props max is 216 on the Acer A750,
 * and the driver refused 0x44000004; the probe proved 250 AND 270 W apply
 * ONLY through the V1 mW setters. Non-W/C controls (percent-unit Battlemage,
 * volt, freq, vram...) route exactly as before (the units check unchanged).
 * `mode` is optional: absent (null/undefined) -> the threshold-based split
 * stays (the UNLISTED/no-caps fallback - the existing pins); the four apply
 * paths always pass the mode (the same value ocModeRefusal receives at the
 * same site - the persisted ocMode for interactive applies, OC_MODE_ADVANCED
 * for profile applies; never caps/extendedRanges, the M3-C-E prohibition).
 * @param {Record<string, unknown>} settings
 * @param {Record<string, { units?: string }>} [ranges]
 * @param {string|null} [mode] OC_MODE_STOCK | OC_MODE_ADVANCED (absent ->
 *   the historical threshold behavior)
 * @returns {{ driverstore: Record<string, unknown>, extended: Record<string, unknown> }}
 */
export function splitByRuntime(settings, ranges = null, mode = null) {
  const driverstore = {};
  const extended = {};
  const isWcUnits = (key) => {
    const units = ranges?.[key]?.units ?? null;
    if (units === null || units === undefined) return true; // unknown -> historical behavior
    return key === 'powerLimitW' ? units === 'W' : units === 'C';
  };
  const isWcControl = (key) => key === 'powerLimitW' || key === 'tempLimitC';
  for (const [key, value] of Object.entries(settings)) {
    if (value === null || value === undefined) continue;
    // M17d (Run D): the MODE-BASED routing for the W/C controls - the
    // V1-call pin. Percent-unit controls (Battlemage) never route extended
    // in either mode (the M2D rule - the units check is the gate).
    if (mode === OC_MODE_ADVANCED && isWcControl(key) && isWcUnits(key)) extended[key] = value;
    else if (mode === OC_MODE_STOCK && isWcControl(key) && isWcUnits(key)) driverstore[key] = value;
    else if (key === 'powerLimitW' && value > STD_PL_MAX_W && isWcUnits('powerLimitW')) extended[key] = value;
    else if (key === 'tempLimitC' && value > STD_TL_MAX_C && isWcUnits('tempLimitC')) extended[key] = value;
    else driverstore[key] = value;
  }
  return { driverstore, extended };
}

/**
 * Pure gating predicate (main-side mirror of the renderer helper): true when
 * the settings contain an extended-range value (PL > 252 W or TL > 90 C)
 * that needs the confirm dialog before applying. When `ranges` is given,
 * the check is unit-aware (M2D): percent-unit ranges (Battlemage mock) are
 * never extended - the real hardware path always passes W/C ranges.
 * @param {Record<string, unknown>} settings
 * @param {Record<string, { units?: string }>} [ranges]
 * @returns {boolean}
 */
export function requiresExtendedRange(settings, ranges = null) {
  if (!settings || typeof settings !== 'object') return false;
  const plRange = ranges?.powerLimitW;
  const tlRange = ranges?.tempLimitC;
  return (typeof settings.powerLimitW === 'number' && settings.powerLimitW > STD_PL_MAX_W && (!plRange || plRange.units === 'W'))
    || (typeof settings.tempLimitC === 'number' && settings.tempLimitC > STD_TL_MAX_C && (!tlRange || tlRange.units === 'C'));
}

/**
 * M17f: the SYSMAN COMPANION - runs AFTER the IGCL power-limit write
 * (driverstore V2 or the bundled-2023-runtime V1 - both route through
 * applySettingsRouted). The IGCL powerLimit control writes the SUSTAINED
 * (PL1) limit only; the burst/boost (PL2) limit is a separate domain. The
 * companion syncs the pair (sustained = the requested value TOO -
 * idempotent with the IGCL PL1 write - plus burst = the requested value)
 * through the injectable sysman consumer (src/main/sysman/power-limits.js).
 *
 * BEST-EFFORT by contract (the plan's round-1 N5 fold): the IGCL read-back
 * stays the CANONICAL verification - a sysman failure NEVER fails the
 * apply when the IGCL write verified. The verdicts surface in the log:
 *   - refused / ERROR_NOT_AVAILABLE -> the KMD-ARBITRATION note (the GPU
 *     under overclocking blocks the sysman power-limit write - the M2b
 *     2026-08-05 experiment's ERROR_NOT_AVAILABLE class);
 *   - accepted-but-no-movement -> the FIRMWARE-PINNED note (the write was
 *     accepted but the burst read-back did not move - the A750 'draw stays
 *     180 W' class);
 *   - moved -> the sync verified (PL1 + PL2 both land on the request).
 * M17n THE V2-CLAMP FALLBACK (round-1 S6 - the user's original M17h
 * design returns as the fallback): the sysman set on the INSTANT
 * 'not-ready' errorCode ONLY (the other failure classes - helper-failed /
 * io-failed / timeout - keep the M17f log-only contract - they are NOT
 * instant) triggers THE V2-CLAMP WRITE - applyOnce { powerLimitW:
 * Math.min(requestedW, ceilingW) } (the driverstore V2 path - no ze - no
 * window - instant: PL2 = min(requested, the driver max)). THE CLAMP IS
 * ADVANCED-MODE-GATED (round-1 S2 - clampAdvanced = the V1-call pin's
 * domain, where the primary write did NOT touch the burst domain; in
 * STOCK mode the not-ready verdict stays the best-effort log - the
 * primary write already landed both limits).
 * M21 (the >315 sysman-PRIMARY case): for a >315 W apply the sysman write
 * IS the primary write (the V1 setter refuses >315 - it would silent-clamp
 * to 315 - and the V2-clamp would silently reduce to 252). The routed
 * block passes `sysmanPrimary: true`, the companion's verdict becomes the
 * perControl, and the movement check gains a DELAYED RE-READ: when the
 * immediate burst read-back did not move, the companion sleeps
 * `delayedVerifyMs` then re-reads BOTH the sysman pair and the backend
 * getCurrentSettings state before the honest verdict - a lagging read-back
 * must not fail a persisted >315 write, and a write that genuinely did not
 * land still fails honestly. The <=315 path's immediate verdict is
 * UNCHANGED.
 * @param {{
 *   sysmanPowerLimits?: { setLimits: (l: { sustainedW: number, burstW: number }) => Promise<{ ok: boolean, errorCode?: string, message?: string }>, readLimits?: () => Promise<{ burstW?: number | null } | null>, warm?: () => Promise<void> } | null, // M19: the proxy's warm seam (the fresh-spawn retry's trigger; absent on the mock/not-ready stubs)
 *   requestedW: number,
 *   log?: (s: string) => void,
 *   sleep?: (ms: number) => Promise<void>, // M19: the retry-loop poll seam (default the real sleep); M21: also the delayed re-read seam
 *   delayedVerifyMs?: number, // M21: the >315 sysman-primary delayed re-read delay (default DELAYED_VERIFY_MS)
 *   backend?: import('./backend/backend.interface.js').IOCBackend | null, // M17n the V2-clamp deps (round-1 S6); M21: also the delayed re-read's getCurrentSettings source
 *   deviceId?: number,
 *   limitsKey?: { pciDeviceId?: string | null, aibVendor?: string | null, aibModel?: string | null } | null,
 *   clampAdvanced?: boolean, // M17n the S2 gate: extended.powerLimitW !== undefined && <= EXTENDED_PL_MAX_W (M21: the <=315 advanced case only)
 *   extendedW?: boolean, // M21: the NOT-READY GATE DECOUPLE - the extended-W-CONTROL gate (extended.powerLimitW !== undefined at the routed block); the warm()-retry runs on it (a STOCK apply keeps the instant best-effort log); ABSENT -> the legacy clampAdvanced gate (the direct-call tests)
 *   sysmanPrimary?: boolean, // M21: the >315 sysman-PRIMARY case - the verdict IS the perControl + the delayed re-read applies
 *   oldIgcl?: { setPowerLimitW: (w: number) => Promise<{ ok: boolean, errorCode?: string, message?: string, readBackEqual?: boolean }> } | null | undefined, // M17n round-2 S1: the re-V1 seam (the clamp branch re-applies the request AFTER the both-limits V2 write)
 * }} deps
 * @returns {Promise<{ landed: boolean, ceilingW?: number, valueW?: number, requestedW?: number, errorCode?: string, message?: string } | null>}
 *   M17n the note-or-null for the applySettingsRouted sysman-companion
 *   block to fold in: null = ONLY the no-sysman-seam case (unreachable -
 *   the routed block is gated); the clamp verdict
 *   { landed: true, ceilingW, valueW, requestedW } / { landed: false };
 *   the ready case { landed: true, valueW: requested }
 *   (the shape the note already carries - a no-op replace).
 *   M21 RETURN-CONTRACT EXTENSION: the failure classes now return
 *   { landed: false, errorCode, message } instead of null - the errorCode
 *   from the sysman set answer where one exists ('ERROR_NOT_AVAILABLE' for
 *   the KMD-arbitration refusal, 'not-ready' for the persistent not-ready,
 *   'io-failed' for threw/no-movement). Never throws.
 */
export async function runSysmanCompanion({ sysmanPowerLimits, requestedW, log = () => {}, backend = null, deviceId = 0, limitsKey = null, clampAdvanced = false, extendedW, sysmanPrimary = false, oldIgcl = null, sleep = defaultSleep, delayedVerifyMs = DELAYED_VERIFY_MS }) {
  if (!sysmanPowerLimits) return null;
  let res;
  try {
    // M21: the deviceId rides as the SECOND argument (the mock seam keys
    // its state write on it; the real adapter + the proxy ignore it).
    res = await sysmanPowerLimits.setLimits({ sustainedW: requestedW, burstW: requestedW }, deviceId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[apply] sysman companion: threw (${msg}) - best-effort only, the IGCL read-back stays the canonical verification`);
    return { landed: false, errorCode: 'io-failed', message: msg };
  }
  if (!res || res.ok !== true) {
    let msg = res?.message ?? res?.errorCode ?? 'unknown';
    let refused = res?.errorCode === 'ERROR_NOT_AVAILABLE'
      || (typeof msg === 'string' && msg.includes('NOT_AVAILABLE'));
    // M21: the NOT-READY GATE DECOUPLE - the warm()-retry runs whenever
    // the extended-W-CONTROL gate holds (backend && warm && extendedW; a
    // STOCK-mode apply keeps the instant best-effort log, the ADVANCED
    // <=315 path keeps its retry exactly as today). `extendedW` ABSENT
    // falls back to the legacy clampAdvanced gate (the direct-call tests
    // pass clampAdvanced only). The V2-CLAMP fallback below STAYS gated on
    // clampAdvanced: for >315 (clampAdvanced false) a persistent not-ready
    // returns the honest { landed: false, errorCode: 'not-ready' } - never
    // a silent 252 clamp.
    if (res?.errorCode === 'not-ready' && (extendedW ?? clampAdvanced) && backend
      && typeof sysmanPowerLimits.warm === 'function') {
      const deadline = Date.now() + NOT_READY_RETRY_BOUND_MS;
      // The warm: spawn the fresh detached helper + connect (fire-and-
      // forget - the retry loop below is the bounded wait; a warm racing
      // the boot's own warm shares ONE connect via the in-flight latch,
      // never a double-spawn).
      try { void sysmanPowerLimits.warm(); } catch { /* best effort */ }
      let retried = null;
      while (Date.now() < deadline) {
        await sleep(NOT_READY_RETRY_POLL_MS);
        try {
          retried = await sysmanPowerLimits.setLimits({ sustainedW: requestedW, burstW: requestedW }, deviceId);
        } catch {
          retried = null;
        }
        if (retried?.ok === true) break;
        if (retried && retried.errorCode !== 'not-ready') break; // a real failure class - stop retrying
      }
      if (retried?.ok === true) {
        log(`[apply] sysman companion: not-ready -> the FRESH helper landed the set (PL2 = ${requestedW} W exactly, the Acer-tool mechanism) - no clamp needed`);
        res = retried;
      } else if (retried && retried.errorCode !== 'not-ready') {
        // The loop stopped on a REAL failure class (the stop condition
        // above) - the refused/failed handling below must run on the TRUE
        // verdict, not the stale first not-ready (which would wrongly fire
        // the V2-clamp on e.g. the KMD-arbitration refusal class).
        res = retried;
        msg = res?.message ?? res?.errorCode ?? 'unknown';
        refused = res?.errorCode === 'ERROR_NOT_AVAILABLE'
          || (typeof msg === 'string' && msg.includes('NOT_AVAILABLE'));
      } else {
        log(`[apply] sysman companion: not-ready persisted across the ${NOT_READY_RETRY_BOUND_MS} ms fresh-spawn retry bound - falling to the V2-clamp`);
      }
    }
    if (!res || res.ok !== true) {
      // M17n THE INSTANT 'not-ready' TRIGGER -> THE V2-CLAMP FALLBACK
      // (round-1 S6): the set answered the proxy's instant not-ready verdict
      // - the sysman layer is NOT coming up in this session (the user's
      // measured pattern) - so the apply must NOT wait: the V2 driverstore
      // write at min(requested, the driver ceiling) lands PL2 = the driver
      // max instantly (no ze, no window). The clamp is ADVANCED-MODE-GATED
      // (round-1 S2): the V1 write set PL1 only, so the burst domain needs
      // the fallback; in STOCK mode the primary V2 write already landed both
      // limits - the not-ready verdict stays the best-effort log. M21: for
      // >315 (clampAdvanced false) the clamp NEVER fires - the persistent
      // not-ready returns the honest { landed: false, errorCode: 'not-ready'
      // } (a clamp would silently reduce the request to 252 - forbidden).
    if (res?.errorCode === 'not-ready' && clampAdvanced && backend) {
      // The DriverStore ceiling: the device-limits STOCK row's PL max (the
      // same source runV2Companion uses - 252 a770 / 216 Acer a750 / 228
      // LE / 252 unlisted).
      const ceilingW = deviceLimitsOf(limitsKey ?? null, { advanced: false })?.powerLimitW?.max ?? STD_PL_MAX_W;
      const valueW = Math.min(requestedW, ceilingW);
      try {
        const out = await applyOnce({ backend, deviceId, settings: { powerLimitW: valueW }, opts: {}, log });
        const per = out.result.perControl?.powerLimitW;
        if (per?.ok === true && per.readBackEqual !== false) {
          // M17n ROUND-2 S1 (the live probe caught the PL1 CLOBBER): the V2
          // write above is the 'both-limits' write - it just OVERWROTE PL1
          // (the V1's requested value) with the clamp value (the live
          // read-back showed PL1 252 / PL2 252 after the clamp). RE-APPLY
          // the V1 so PL1 ends at the REQUESTED value: the final = PL1 =
          // requested + PL2 = min(requested, ceiling). The re-V1 is
          // IDEMPOTENT with the primary V1 write (same value - its burst
          // effect can only keep-or-lower toward the ceiling, never raise
          // above the clamp's value - the 11:26 + Arm-B evidence). The
          // re-V1's own ALWAYS-delayed verification stays (the only trusted
          // read-back; its ~400 ms keeps the not-ready path's total ~800-
          // 900 ms < the 1 s criterion - the elapsed measured live).
          // The re-V1 FAILURE degrades the note to the honest { landed:
          // false } - the clamp may have landed PL2 but PL1 is UNCERTAIN
          // (no '(set)' claim).
          let reV1;
          if (oldIgcl && typeof oldIgcl.setPowerLimitW === 'function') {
            try {
              reV1 = await oldIgcl.setPowerLimitW(requestedW);
            } catch (err) {
              log(`[apply] sysman companion: the V2-CLAMP wrote PL2 = ${valueW} W but the re-V1 (PL1 = ${requestedW} W) threw (${err instanceof Error ? err.message : String(err)}) - PL1 is uncertain - the honest { landed: false } (no '(set)' claim)`);
              return { landed: false };
            }
          }
          if (reV1?.ok === true && reV1.readBackEqual !== false) {
            log(`[apply] sysman companion: the helper is NOT ready - THE V2-CLAMP wrote PL2 = ${valueW} W (min(${requestedW} W requested, the ${ceilingW} W driver ceiling)) via the driverstore fallback + the re-V1 re-applied PL1 = ${requestedW} W (the both-limits write overwrote it) - the apply never waited`);
            // M17o: the clamp note carries the REQUESTED burst (the
            // read-out's promise sentence: 'it will be raised to <requestedW>
            // W automatically when the sysman layer finishes initializing' -
            // the auto-upgrade intent flow lands the exact value at init).
            return { landed: true, ceilingW, valueW, requestedW };
          }
          log(`[apply] sysman companion: the helper is NOT ready - the V2-CLAMP wrote PL2 = ${valueW} W but the re-V1 (PL1 = ${requestedW} W) did not verify (${reV1?.errorCode ?? reV1?.message ?? (oldIgcl ? 'unknown' : 'no oldIgcl seam')}) - PL1 is uncertain - the honest { landed: false } (no '(set)' claim)`);
          return { landed: false };
        }
        log(`[apply] sysman companion: the helper is NOT ready - the V2-CLAMP write failed (${per?.errorCode ?? per?.message ?? 'unknown'}) - PL2 stayed - best-effort only, the IGCL read-back stays the canonical verification`);
        return { landed: false };
      } catch (err) {
        log(`[apply] sysman companion: the helper is NOT ready - the V2-CLAMP write threw (${err instanceof Error ? err.message : String(err)}) - PL2 stayed - best-effort only, the IGCL read-back stays the canonical verification`);
        return { landed: false };
      }
    }
    if (res?.errorCode === 'not-ready') {
      // M21: the persistent not-ready without the clamp gate (>315: the
      // honest refusal - never a silent 252 clamp; STOCK: the instant
      // best-effort class). The errorCode-bearing shape folds into the
      // pl2Note ONLY for the >315 sysman-primary case.
      log(`[apply] sysman companion: not-ready (${msg}) - the honest { landed: false, errorCode: 'not-ready' } (never a silent clamp)`);
      return { landed: false, errorCode: 'not-ready', message: res?.message ?? msg };
    }
    log(refused
      ? `[apply] sysman companion: REFUSED (${msg}) - the KMD-arbitration note (the GPU under overclocking blocks the sysman power-limit write); the IGCL read-back stays the canonical verification`
      : `[apply] sysman companion: failed (${msg}) - best-effort only, the IGCL read-back stays the canonical verification`);
    return { landed: false, errorCode: refused ? (typeof res?.errorCode === 'string' ? res.errorCode : 'ERROR_NOT_AVAILABLE') : (typeof res?.errorCode === 'string' ? res.errorCode : 'io-failed'), message: msg };
    }
  }
  // The movement verdict: re-read the burst - accepted-but-no-movement is
  // the firmware-pinned note (a DIFFERENT honest outcome from a refusal).
  let moved = false;
  try {
    const after = await sysmanPowerLimits.readLimits?.();
    moved = after !== null && after !== undefined
      && typeof after.burstW === 'number' && Math.abs(after.burstW - requestedW) <= 1;
  } catch {
    moved = false;
  }
  if (moved) {
    log(`[apply] sysman companion: PL1 + PL2 = ${requestedW} W (the burst read-back verified - the PL2 sync landed)`);
    // M17n: the sysman-READY case is UNCHANGED ({ landed: true, valueW:
    // requested } - the same shape the pl2Note already carries in the
    // landed paths; the fold-in replaces a same-shaped note with itself).
    return { landed: true, valueW: requestedW };
  }
  if (sysmanPrimary) {
    // M21 (R2-F4 + R4-F6): the >315 sysman-PRIMARY delayed re-read - the
    // immediate verdict cannot ride a lagging read-back (a persisted >315
    // write must not fail on it): sleep the routed delay, then re-read
    // BOTH the sysman pair and the backend getCurrentSettings state before
    // the honest verdict.
    await sleep(delayedVerifyMs);
    let moved2 = false;
    try {
      const after2 = await sysmanPowerLimits.readLimits?.();
      moved2 = after2 !== null && after2 !== undefined
        && typeof after2.burstW === 'number' && Math.abs(after2.burstW - requestedW) <= 1;
    } catch {
      moved2 = false;
    }
    let backendMatched = false;
    if (backend && typeof backend.getCurrentSettings === 'function') {
      try {
        const st = await backend.getCurrentSettings(deviceId);
        backendMatched = st !== null && st !== undefined
          && typeof st.powerLimitW === 'number' && Math.abs(st.powerLimitW - requestedW) <= 1;
      } catch {
        backendMatched = false;
      }
    }
    if (moved2 || backendMatched) {
      log(`[apply] sysman companion: the ${delayedVerifyMs} ms delayed re-read verified the persisted ${requestedW} W pair (the sysman-primary write landed - the read-back lagged)`);
      return { landed: true, valueW: requestedW };
    }
    log(`[apply] sysman companion: the sysman-primary write did NOT land - the delayed re-read of both the sysman pair and the backend state still mismatches - the honest failure (the IGCL read-back stays the canonical verification)`);
    return { landed: false, errorCode: 'io-failed', message: 'the sysman write did not persist (the delayed re-read of the sysman pair and the backend state still mismatched)' };
  }
  log(`[apply] sysman companion: the write was ACCEPTED but the burst read-back did not move - the firmware-pinned note (the KMD enforces its own budget); the IGCL read-back stays the canonical verification`);
  return { landed: false, errorCode: 'io-failed', message: 'the write was accepted but the burst read-back did not move - the firmware-pinned class (the KMD enforces its own budget)' };
}

/**
 * M17g: THE V2 COMPANION (the PL2-on-advanced fix - the 180 W mystery
 * resolution). The DriverStore V2 setter (the STOCK path) writes BOTH
 * package limits (PL1 + PL2 - the user's observation); the bundled
 * 2023-runtime V1 setter (the ADVANCED path - the V1-call pin) writes PL1
 * ONLY, so an advanced-mode apply leaves the burst (PL2) domain at its
 * stock level and the enforced draw follows PL2 (the A750 'draw stays
 * 180 W' class). The companion issues ONE best-effort V2 write of the
 * same value through the SAME applyOnce the driverstore block uses - the
 * driver's own acceptance is the gate (NO pre-check against caps.ranges:
 * the advanced caps show the KMD ceiling 315/270, never the DriverStore
 * acceptance 252/216 - a pre-check would be vacuous).
 *
 * BEST-EFFORT by contract (the sysman-companion precedent): the V1
 * read-back stays the CANONICAL verification - the companion NEVER fails
 * the apply and NEVER touches perControl. The verdicts:
 *   - ok -> the burst domain follows per the stock-path behavior;
 *   - refused (0x44000004 -> the canonical 'out-of-range' class - the
 *     value above the DriverStore ceiling) -> the PL2-PINNED NOTE (round-1
 *     N4 wording) - the V1 write still applied the sustained (PL1) limit;
 *   - any other failure (io-failed / silent-noop) -> best-effort log only;
 *     the SILENT-NOOP case is UNDETECTABLE via IGCL (PL2 is invisible to
 *     IGCL - the M17f premise) - the movement verdict stays the sysman
 *     read-back where the layer works, documented.
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   deviceId: number,
 *   requestedW: number,
 *   opts?: Record<string, unknown>,
 *   log?: (s: string) => void,
 *   limitsKey?: { pciDeviceId?: string | null, aibVendor?: string | null, aibModel?: string | null } | null,
 * }} deps
 * @returns {Promise<{ landed: boolean, ceilingW?: number }>} the verdict
 *   the pl2Note rides on (the ceiling only when the write was REFUSED)
 */
export async function runV2Companion({ backend, deviceId, requestedW, opts = {}, log = () => {}, limitsKey = null }) {
  // The DriverStore ceiling for the note: the device-limits STOCK row's PL
  // max (the per-AIB documented ceiling - A750 ASRock/Acer 216, A770 LE
  // 228) with the 252 default for unlisted cards (the same source the
  // stock slider exposes - the note never invents a ceiling).
  const ceilingW = deviceLimitsOf(limitsKey ?? null, { advanced: false })?.powerLimitW?.max ?? STD_PL_MAX_W;
  try {
    const out = await applyOnce({ backend, deviceId, settings: { powerLimitW: requestedW }, opts, log });
    const per = out.result.perControl?.powerLimitW;
    if (per?.ok === true && per.readBackEqual !== false) {
      log(`[apply] V2 companion: the PL2 burst write landed (the burst domain follows per the stock-path behavior)`);
      return { landed: true };
    }
    if (per?.ok === false && per?.errorCode === 'out-of-range') {
      // 0x44000004 class - the value above the DriverStore ceiling (e.g.
      // 300 W on the A770, 250 W on the Acer A750). The PL2-PINNED NOTE
      // (round-1 N4): never a failed apply - the V1 read-back stays the
      // canonical verification; the sustained (PL1) limit IS set.
      log(`[apply] V2 companion: REFUSED - the burst limit (PL2) stays at its CURRENT value - the V2 setter refuses above the driver ceiling (${ceilingW} W) - the sustained limit (PL1) is set`);
      return { landed: false, ceilingW };
    }
    log(`[apply] V2 companion: failed (${per?.errorCode ?? per?.message ?? 'unknown'}) - best-effort only, the V1 read-back stays the canonical verification (the burst may not have moved; the movement verdict stays the sysman read-back where the layer works)`);
    return { landed: false };
  } catch (err) {
    log(`[apply] V2 companion: threw (${err instanceof Error ? err.message : String(err)}) - best-effort only, the V1 read-back stays the canonical verification`);
    return { landed: false };
  }
}

// M26: the safe voltage floor (canonical volts). No live write below this
// value. The live capability 0/0 bounds are diagnostic only; the
// The UI exposes -0.500 V in stock and -0.800 V in Advanced. The routed
// backend safety bound is the deepest approved Advanced value.
export const SAFE_VOLT_OFFSET_MIN_V = -0.800;

/**
 * M26: route a negative gpuVoltOffsetV through the Sysman frequency OC
 * setter. The Sysman path reads the current target first, converts
 * canonical volts to the driver's mV boundary, writes, and verifies via
 * the same getter. A mismatch is a failed per-control result.
 *
 * @param {{
 *   sysmanPowerLimits?: { setVoltageOffset?: (p: { offsetV: number }, deviceId?: number) => Promise<{ ok: boolean, offsetV?: number, errorCode?: string, message?: string }> } | null,
 *   offsetV: number,
 *   deviceId?: number,
 *   log?: (s: string) => void,
 * }} deps
 * @returns {Promise<{ ok: boolean, offsetV?: number, errorCode?: string, message?: string }>}
 */
export async function runSysmanVoltageOffset({ sysmanPowerLimits, offsetV, deviceId = 0, log = () => {} }) {
  if (!sysmanPowerLimits || typeof sysmanPowerLimits.setVoltageOffset !== 'function') {
    return { ok: false, errorCode: 'unsupported', message: 'the sysman voltage offset setter is unavailable' };
  }
  if (!Number.isFinite(offsetV) || offsetV >= 0) {
    return { ok: false, errorCode: 'invalid-argument', message: 'runSysmanVoltageOffset requires a negative finite offsetV' };
  }
  const clamped = Math.max(SAFE_VOLT_OFFSET_MIN_V, offsetV);
  if (clamped !== offsetV) {
    log(`[apply] sysman voltage: clamped ${offsetV} V to the safe floor ${SAFE_VOLT_OFFSET_MIN_V} V`);
  }
  try {
    const res = await sysmanPowerLimits.setVoltageOffset({ offsetV: clamped }, deviceId);
    const verified = res?.ok === true && Number.isFinite(res.offsetV)
      && (res.exactReadBack === true
        ? res.offsetV < 0 && Math.abs(res.offsetV) <= Math.abs(clamped) + 0.001
        : Math.abs(res.offsetV - clamped) <= 0.001);
    if (verified) {
      log(`[apply] sysman voltage: offset ${res.offsetV} V (read-back verified)`);
      return { ...res, ok: true, offsetV: res.offsetV };
    }
    if (res?.ok === true) {
      const message = `sysman voltage setter returned an invalid read-back for ${clamped} V`;
      log(`[apply] sysman voltage: FAILED (${message})`);
      return { ok: false, errorCode: 'io-failed', message };
    }
    log(`[apply] sysman voltage: FAILED (${res?.errorCode ?? res?.message ?? 'unknown'})`);
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[apply] sysman voltage: threw (${msg})`);
    return { ok: false, errorCode: 'io-failed', message: msg };
  }
}

/**
 * Clear a previously routed negative Sysman voltage offset before applying
 * the positive/zero IGCL control. Without this transition, a later positive
 * or reset apply can leave the old Sysman curve offset active while the
 * backend reports only the IGCL value.
 *
 * A missing/degraded read is best-effort and does not block the IGCL path.
 * Once the read proves a negative offset is active, a failed clear is an
 * honest per-control refusal and the IGCL voltage write is skipped.
 *
 * @param {{
 *   sysmanPowerLimits?: {
 *     readVoltageOffsetResult?: (deviceId?: number) => Promise<{ ok: boolean, targetV?: number, offsetV?: number, errorCode?: string, message?: string }>,
 *     readVoltageOffset?: (deviceId?: number) => Promise<{ offsetV?: number } | null>,
 *     setVoltageOffset?: (p: { offsetV: number }, deviceId?: number) => Promise<{ ok: boolean, errorCode?: string, message?: string }>,
 *   } | null,
 *   log?: (s: string) => void,
 * }} deps
 * @returns {Promise<{ ok: boolean, checked: boolean, errorCode?: string, message?: string }>}
 */
async function clearNegativeSysmanVoltage({ sysmanPowerLimits, deviceId, log = () => {} }) {
  const readWithStatus = typeof sysmanPowerLimits?.readVoltageOffsetResult === 'function';
  let current;
  if (readWithStatus) {
    let status;
    try {
      status = await sysmanPowerLimits.readVoltageOffsetResult(deviceId);
    } catch (err) {
      return {
        ok: false,
        checked: true,
        errorCode: 'io-failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }
    if (status?.ok !== true) {
      // A not-ready helper cannot prove that a prior VF state is absent; only
      // an explicit unsupported capability is safe to bypass.
      if (status?.errorCode === 'unsupported') {
        return { ok: true, checked: false };
      }
      return {
        ok: false,
        checked: true,
        errorCode: status?.errorCode ?? 'io-failed',
        message: status?.message ?? 'the prior negative sysman voltage offset could not be read',
      };
    }
    current = status;
  } else {
    if (typeof sysmanPowerLimits?.readVoltageOffset !== 'function'
      || typeof sysmanPowerLimits?.setVoltageOffset !== 'function') {
      return { ok: true, checked: false };
    }
    try {
      current = await sysmanPowerLimits.readVoltageOffset(deviceId);
    } catch {
      return { ok: true, checked: false };
    }
  }
  if (!current || (current.needsClear !== true
    && (typeof current.offsetV !== 'number' || !Number.isFinite(current.offsetV) || current.offsetV >= 0))) {
    return { ok: true, checked: true };
  }
  try {
    const cleared = await sysmanPowerLimits.setVoltageOffset({ offsetV: 0 }, deviceId);
    if (cleared?.ok === true) {
      log(`[apply] sysman voltage: cleared prior negative offset ${current.offsetV} V before the non-negative IGCL apply`);
      return { ok: true, checked: true };
    }
    return {
      ok: false,
      checked: true,
      errorCode: cleared?.errorCode ?? 'io-failed',
      message: cleared?.message ?? 'the prior negative sysman voltage offset could not be cleared',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, checked: true, errorCode: 'io-failed', message };
  }
}

/**
 * A failed per-control result can be a non-persisting write (the momentary
 * lie) rather than a real refusal: the shape is SUCCESS from the setter with
 * a read-back mismatch (silentNoop) or a generic io-failed read-back
 * mismatch. Hard errors (out-of-range, waiver-not-set, ...) are definite
 * failures and never re-read.
 * @param {{ ok: boolean, readBackEqual?: boolean, errorCode?: string, silentNoop?: boolean }} per
 * @returns {boolean}
 */
export function isMomentaryLieCandidate(per) {
  if (!per || per.ok !== false) return false;
  if (per.readBackEqual === true) return false;
  if (per.errorCode && per.errorCode !== 'io-failed') return false;
  return per.silentNoop === true || per.errorCode === 'io-failed';
}

/**
 * Apply a Settings payload with per-control runtime routing.
 *
 * - driverstore controls: one instant attempt via applyOnce (the F3
 *   instant-apply core); any momentary-lie candidate is re-read once after
 *   `delayedVerifyMs` - a match upgrades the control to ok.
 * - extended controls: routed to the bundled 2023 runtime (oldIgcl), which
 *   performs its own delayed verification. If the old runtime is not
 *   capable, the control fails honestly with EXTENDED_UNAVAILABLE_MSG.
 *
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   oldIgcl: {
 *     isCapable: () => Promise<boolean>,
 *     setPowerLimitW: (w: number) => Promise<{ ok: boolean, errorCode?: string, message?: string, readBackEqual?: boolean }>,
 *     setTempLimitC: (c: number) => Promise<{ ok: boolean, errorCode?: string, message?: string, readBackEqual?: boolean }>,
 *   },
 *   deviceId: number,
 *   settings: Record<string, unknown>,
 *   opts?: Record<string, unknown>,
 *   log?: (s: string) => void,
 *   delayedVerifyMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   ranges?: Record<string, { units?: string }> | null, // M2D: unit-aware split
 *   mode?: string | null, // M17d (Run D): OC_MODE_STOCK | OC_MODE_ADVANCED -
 *                         // the V1-call pin (splitByRuntime's mode routing);
 *                         // absent -> the historical threshold split
 *   sysmanPowerLimits?: object | null, // M17f: the sysman PL2 companion
 *                         // consumer (src/main/sysman/power-limits.js) -
 *                         // runs AFTER the IGCL PL write; best-effort
 *   limitsKey?: { pciDeviceId?: string | null, aibVendor?: string | null, aibModel?: string | null } | null, // M17g: the caps identity for the V2 companion's ceiling note (the device-limits STOCK row's PL max - the DriverStore ceiling; absent -> the 252 default)
 * }} deps
 * @returns {Promise<{
 *   result: { ok: boolean, perControl: Record<string, { ok: boolean, errorCode?: string, message?: string, readBackEqual?: boolean, silentNoop?: boolean }>, pl2Note: { landed: boolean, ceilingW?: number, valueW?: number } | null },
 *   attempts: number,
 * }>}
 */
export async function applySettingsRouted({ backend, oldIgcl, deviceId, settings, opts = {}, log = () => {}, delayedVerifyMs = DELAYED_VERIFY_MS, sleep = defaultSleep, ranges = null, mode = null, sysmanPowerLimits = null, limitsKey = null }) {
  const { driverstore, extended } = splitByRuntime(settings, ranges, mode);
  const voltageIsVUnit = ranges === null || ranges?.gpuVoltOffsetV?.units === 'V';

  // M26: the backend normalizes a non-zero GPU lock to zero offsets. Do not
  // route a conflicting negative voltage after that lock has landed; the
  // lock's zero-offset contract wins and the negative request is ignored in
  // the same way the direct backend path ignores it.
  const lockForcesZero = !!(settings.gpuLock && typeof settings.gpuLock === 'object'
    && (settings.gpuLock.voltageV !== 0 || settings.gpuLock.freqMhz !== 0));
  const negativeVoltOffsetV = voltageIsVUnit && !lockForcesZero
    && typeof driverstore.gpuVoltOffsetV === 'number' && driverstore.gpuVoltOffsetV < 0
    ? driverstore.gpuVoltOffsetV
    : undefined;
  if (negativeVoltOffsetV !== undefined) {
    delete driverstore.gpuVoltOffsetV;
  }

  const perControl = {};

  // M26: a non-negative voltage request is the transition back to the IGCL
  // control. A lock request also normalizes the IGCL offsets to zero (even
  // when the voltage key is absent), so it must clear a previously routed
  // Sysman offset before the lock lands.
  const lockRequestsOffsetZero = !!(settings.gpuLock && typeof settings.gpuLock === 'object');
  const nonNegativeVoltOffsetV = typeof settings.gpuVoltOffsetV === 'number' && settings.gpuVoltOffsetV >= 0
    ? settings.gpuVoltOffsetV
    : undefined;
  if (voltageIsVUnit && (nonNegativeVoltOffsetV !== undefined || lockRequestsOffsetZero)) {
    const clear = await clearNegativeSysmanVoltage({ sysmanPowerLimits, deviceId, log });
    if (!clear.ok) {
      delete driverstore.gpuVoltOffsetV;
      if (lockRequestsOffsetZero) delete driverstore.gpuLock;
      const failure = {
        ok: false,
        errorCode: clear.errorCode ?? 'io-failed',
        message: clear.message ?? 'the prior negative sysman voltage offset could not be cleared',
      };
      perControl.gpuVoltOffsetV = failure;
      if (lockRequestsOffsetZero) perControl.gpuLock = failure;
    }
  }

  if (Object.keys(driverstore).length > 0) {
    log(`[apply] driverstore controls: [${Object.keys(driverstore).join(', ')}] (single attempt)`);
    const out = await applyOnce({ backend, deviceId, settings: driverstore, opts, log });
    Object.assign(perControl, out.result.perControl);

    // Momentary-lie guard for the driverstore part: re-read mismatches once
    // after the delay. A match = the write persisted (lagging read-back);
    // still mismatched = honest fail.
    const candidates = Object.keys(driverstore).filter((k) => isMomentaryLieCandidate(perControl[k]));
    if (candidates.length > 0) {
      log(`[apply] delayed re-read for [${candidates.join(', ')}] after ${delayedVerifyMs} ms (momentary-lie guard)`);
      await sleep(delayedVerifyMs);
      let state = null;
      try { state = await backend.getCurrentSettings(deviceId); } catch { /* degraded re-read */ }
      if (state) {
        for (const key of candidates) {
          const wanted = driverstore[key];
          const got = state[key];
          if (typeof wanted === 'number' && typeof got === 'number' && nearlyEqual(got, wanted)) {
            log(`[apply] delayed re-read MATCHED ${key} (${got}) - write persisted`);
            perControl[key] = { ok: true, readBackEqual: true };
          }
        }
      }
    }
  }

  if (Object.keys(extended).length > 0) {
    log(`[apply] extended controls: [${Object.keys(extended).join(', ')}] via the bundled 2023 IGCL runtime`);
    for (const [key, value] of Object.entries(extended)) {
      // M21: the >315 sysman-PRIMARY gate - the V1 write must NEVER receive
      // a >315 value (oldIgcl.setPowerLimitW silent-clamps to
      // EXTENDED_PL_RANGE 315 and reports { ok: true, readBackEqual: true }
      // - the forbidden silent clamp). The >315 powerLimitW is SKIPPED here
      // entirely (perControl.powerLimitW stays undefined - the sysman
      // companion block below fills it with the sysman verdict). tempLimitC
      // keeps the V1 path (the 115 C ceiling is unchanged).
      if (key === 'powerLimitW' && value > EXTENDED_PL_MAX_W) continue;
      // M17d (step-4 N2): a NULL oldIgcl must never throw (the advanced-
      // mode + null-oldIgcl construct would TypeError on setPowerLimitW,
      // surfacing as 'apply threw: ...') - the honest per-control
      // 'unsupported' refusal, the same shape the runtime itself reports
      // when it cannot load.
      let per;
      if (oldIgcl) {
        per = key === 'powerLimitW'
          ? await oldIgcl.setPowerLimitW(value)
          : await oldIgcl.setTempLimitC(value);
      } else {
        per = { ok: false, errorCode: 'unsupported', message: EXTENDED_UNAVAILABLE_MSG };
      }
      perControl[key] = per;
    }
    // M17d (Run E): the V1-path G2 mirror - the DriverStore runtime's own
    // applySettings clears the stale in-memory waiver flag when a write
    // answers waiver-not-set (igcl-backend.js + the mock mirror), but the
    // bundled 2023 runtime is a SEPARATE adapter whose waiver-not-set
    // answers never touched the backend flag. Without this routed-level
    // mirror the renderer's fresh-caps re-prompt (M4-D F5) is dead on every
    // V1-routed apply - the driver truth stays hidden behind a stale
    // "accepted" caps flag. restoreWaiverState(false) NEVER accepts
    // anything - it only clears the stale flag (re-acceptance still runs
    // through the explicit waiver-accept path).
    if (Object.values(perControl).some((p) => p?.errorCode === 'waiver-not-set')) {
      log('[apply] extended-path waiver-not-set - clearing the stale in-memory waiver flag (the V1-path G2 mirror)');
      try { await backend.restoreWaiverState(deviceId, false); } catch { /* best effort */ }
    }
  }

  // M17g: THE V2 COMPANION + the pl2Note (the PL2-on-advanced fix + the
  // PL1/PL2 read-out's tracking source). After BOTH routed blocks have
  // run + verified, the companion issues ONE best-effort V2 write of the
  // same value so the burst (PL2) domain follows the advanced-mode apply
  // (the V1 write sets PL1 only - the 180 W mystery). The pl2Note rides
  // the envelope for EVERY W-unit powerLimitW apply in BOTH modes:
  //   - STOCK: the primary V2 write's verdict is the note ('landed: true' -
  //     both limits landed per the stock-path behavior; the perControl
  //     ok already verified it). The companion NEVER fires in stock mode
  //     (the driverstore block itself wrote the value - a perControl-only
  //     gate would fire a REDUNDANT second V2 write on every stock apply);
  //   - ADVANCED: the companion verdict (landed / refused -> the ceiling
  //     note with ceilingW = the DriverStore ceiling).
  // The emission gate is precise: ONLY when `typeof settings.powerLimitW
  // === 'number'` AND the units gate holds (the mirror of the sysman gate
  // below - the b580 percent device never emits) AND the IGCL write
  // verified (a failed PL1 write never lands a companion write that leaves
  // the pair inconsistent, and never feeds a dishonest '(set)').
  // THE ORDER IS PINNED: the V2 companion runs FIRST, the M17f sysman
  // companion SECOND (both best-effort, both write the same burst value;
  // the sysman's sustained write is idempotent with the V1 write - either
  // order is correct, one is pinned so the implementer never invents a
  // dependency).
  const plUnits = ranges?.powerLimitW?.units;
  const wUnits = plUnits === undefined || plUnits === 'W';
  let pl2Note = null;
  if (typeof settings.powerLimitW === 'number' && wUnits && perControl.powerLimitW?.ok === true) {
    if (extended.powerLimitW !== undefined) {
      // ADVANCED: the V2 companion (the gate rides ALL FOUR apply paths
      // for free: in-process runApply, the elevated worker, boot,
      // profile). POWERLIMIT-ONLY - tempLimitC never rides the companion.
      // The note is built in the PINNED shape order ({ landed, ceilingW?,
      // valueW } - round-2 N2) so the envelope pins can deepEqual it.
      const verdict = await runV2Companion({ backend, deviceId, requestedW: settings.powerLimitW, opts, log, limitsKey });
      pl2Note = { landed: verdict.landed, ...(verdict.ceilingW !== undefined ? { ceilingW: verdict.ceilingW } : {}), valueW: settings.powerLimitW };
    } else {
      // STOCK: the primary V2 write's verdict (the perControl ok already
      // verified it - both limits landed per the stock-path behavior).
      pl2Note = { landed: true, valueW: settings.powerLimitW };
    }
  }

  // M17f: THE SYSMAN COMPANION - after BOTH routed paths (the driverstore
  // V2 write + the extended V1 write) have run + verified, sync the PL2
  // burst domain. Gated on the IGCL power-limit control's VERIFIED result:
  // a failed PL1 write must never land a sysman burst write that leaves the
  // pair inconsistent (burst = the request while sustained stayed). The
  // companion is best-effort - it never touches perControl (the IGCL
  // read-back stays the canonical verification; a sysman failure is logged,
  // never a failed apply).
  // M17f (step-4 S1): the companion is UNITS-GATED on the REAL path too
  // (the mock seam's percent gate mirrors this) - the sysman layer reads +
  // writes WATTS regardless of the IGCL units, so a PERCENT-unit PL apply
  // (Battlemage: the '100 %' slider) must NEVER land a 100 W absolute
  // zesPowerSetLimits that could lower the enforced limit below stock
  // while the verdict logs 'verified'. SKIP when the units are DEFINED and
  // NOT 'W'; the IGCL write itself still verifies via its read-back.
  // M17n (round-1 S6): the runSysmanCompanion SIGNATURE EXTENSION - the
  // clamp deps (backend, deviceId, limitsKey) + the clampAdvanced gate
  // (the V1-call pin's domain) + the note-or-null return the block folds
  //   in: the V2-CLAMP verdict (the instant 'not-ready' trigger) REPLACES
  //   any earlier note - incl. the M17g refused note, which the clamp's
  //   landed note supersedes (the precedence pinned); the ready case's
  //   { landed: true, valueW: requested } is the shape the note already
  //   carries (a no-op replace); null = the M17f log-only classes (the note
  //   stays untouched).
  //   M17n ROUND-2 S1: the clamp branch gains the oldIgcl seam - the
  //   both-limits V2 clamp write overwrites PL1, so the branch RE-APPLIES
  //   the V1 (oldIgcl.setPowerLimitW(requestedW)) after the clamp; the
  //   re-V1 failure degrades the note to the honest { landed: false }.
  // M21 (the >315 sysman-PRIMARY case): the fire-gate becomes
  // `typeof settings.powerLimitW === 'number' && sysmanPowerLimits &&
  // wUnits` with the V1-ok requirement applying ONLY to <=315. For a
  // >315 powerLimitW (sysmanPrimary - the V1 write was SKIPPED above, so
  // perControl.powerLimitW is undefined) the sysman write IS the PRIMARY
  // write and its verdict IS the perControl: landed -> { ok: true,
  // readBackEqual: true }; landed:false -> { ok: false, errorCode, message
  // } from the extended contract; sysmanPowerLimits absent -> the honest
  // { ok: false, errorCode: 'unsupported', message: EXTENDED_UNAVAILABLE_MSG
  // } (state UNTOUCHED - never a clamp). THE pl2Note FOLD GATE (R4-F3):
  // the fold discriminates SHAPES, not modes - the SUCCESS shape
  // ({ landed: true, valueW } - incl. the clamp verdict
  // { landed: true, ceilingW, valueW, requestedW }) folds in ALL modes;
  // the ERRORCODE-LESS { landed: false } clamp-failure verdict folds in ALL
  // modes; ONLY the NEW errorCode-bearing { landed: false, errorCode,
  // message } shapes fold when extended.powerLimitW > EXTENDED_PL_MAX_W (a
  // <=315 errorCode-bearing failure class leaves the pl2Note UNTOUCHED -
  // the STOCK not-ready pin keeps { landed: true, valueW }).
  const sysmanPrimary = typeof extended.powerLimitW === 'number' && extended.powerLimitW > EXTENDED_PL_MAX_W;
  if (sysmanPrimary) {
    if (sysmanPowerLimits && wUnits) {
      const sysmanNote = await runSysmanCompanion({
        sysmanPowerLimits,
        requestedW: settings.powerLimitW,
        log,
        backend,
        deviceId,
        limitsKey,
        clampAdvanced: false, // >315 NEVER fires the V2-CLAMP (it would silently reduce to 252)
        extendedW: true,
        sysmanPrimary: true,
        oldIgcl,
        sleep,
        delayedVerifyMs,
      });
      if (sysmanNote?.landed === true) {
        perControl.powerLimitW = { ok: true, readBackEqual: true };
      } else if (sysmanNote) {
        perControl.powerLimitW = { ok: false, errorCode: sysmanNote.errorCode ?? 'io-failed', message: sysmanNote.message ?? 'the sysman power-limit write did not land' };
      } else {
        perControl.powerLimitW = { ok: false, errorCode: 'io-failed', message: 'the sysman power-limit write did not land' };
      }
      // The fold: EVERY sysmanPrimary shape folds (the sysman verdict owns
      // the note + the perControl for >315).
      if (sysmanNote) pl2Note = sysmanNote;
    } else if (!sysmanPowerLimits) {
      // The honest capability refusal - never a clamp, state untouched.
      perControl.powerLimitW = { ok: false, errorCode: 'unsupported', message: EXTENDED_UNAVAILABLE_MSG };
      log(`[apply] sysman companion: >${EXTENDED_PL_MAX_W} W requested but the sysman layer is ABSENT - the honest 'unsupported' refusal (never a silent clamp)`);
    }
  } else if (typeof settings.powerLimitW === 'number' && perControl.powerLimitW?.ok === true && sysmanPowerLimits && wUnits) {
    const sysmanNote = await runSysmanCompanion({
      sysmanPowerLimits,
      requestedW: settings.powerLimitW,
      log,
      backend,
      deviceId,
      limitsKey,
      // M21: the clampAdvanced computation is PINNED (R2-F3): the V2-CLAMP
      // fires ONLY for an extended control AT OR BELOW the V1 write range
      // (extended.powerLimitW <= EXTENDED_PL_MAX_W) - the >315 case NEVER
      // fires it (a persistent >315 not-ready must refuse honestly, never
      // a silent 252).
      clampAdvanced: extended.powerLimitW !== undefined && extended.powerLimitW <= EXTENDED_PL_MAX_W,
      extendedW: extended.powerLimitW !== undefined,
      sysmanPrimary: false,
      oldIgcl,
      sleep,
      delayedVerifyMs,
    });
    // THE pl2Note FOLD GATE (M21): the SUCCESS shape + the ERRORCODE-LESS
    // failure shape fold in ALL modes; an errorCode-bearing failure class
    // (the M21 extension) leaves the pl2Note UNTOUCHED for <=315 (this
    // branch is unreachable for >315 - the sysmanPrimary branch owns it).
    if (sysmanNote && (sysmanNote.landed === true || sysmanNote.errorCode === undefined)) pl2Note = sysmanNote;
  } else if (typeof settings.powerLimitW === 'number' && perControl.powerLimitW?.ok === true && sysmanPowerLimits && plUnits !== 'W') {
    log(`[apply] sysman companion: SKIPPED - the powerLimitW units are '${plUnits}' (the sysman layer is W-only; the percent apply stays IGCL-verified)`);
  }

  // M26: route negative gpuVoltOffsetV through Sysman after normal controls.
  // The negative value was removed from the IGCL driverstore payload above;
  // it is applied here via the Sysman frequency OC setter, and the
  // perControl.gpuVoltOffsetV is set from the Sysman read-back. Report
  // per-control success only after Sysman read-back verification.
  if (negativeVoltOffsetV !== undefined && typeof sysmanPowerLimits?.setVoltageOffset === 'function') {
    const voltResult = await runSysmanVoltageOffset({ sysmanPowerLimits, offsetV: negativeVoltOffsetV, deviceId, log });
    perControl.gpuVoltOffsetV = voltResult.ok === true
      ? { ok: true, readBackEqual: true }
      : { ok: false, errorCode: voltResult.errorCode ?? 'io-failed', message: voltResult.message ?? 'the sysman voltage offset write did not verify' };
  } else if (negativeVoltOffsetV !== undefined) {
    // Missing Sysman or failed verification is an honest per-control failure.
    perControl.gpuVoltOffsetV = { ok: false, errorCode: 'unsupported', message: 'negative gpuVoltOffsetV requires the sysman voltage offset setter' };
  }

  const ok = Object.keys(perControl).length === 0
    ? true
    : Object.values(perControl).every((p) => p.ok === true);
  return { result: { ok, perControl, pl2Note }, attempts: 1 };
}

/**
 * Full in-process apply (the elevated path / the apply-worker): clamp to the
 * capability ranges, run the routed core, then read the fresh device state
 * for the caller (the renderer refreshes from it; IGS may change OC state
 * between runs). Electron-free.
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   oldIgcl: object,
 *   deviceId: number,
 *   settings: Record<string, unknown>,
 *   opts?: Record<string, unknown>,
 *   log?: (s: string) => void,
 *   delayedVerifyMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   ocMode?: string | null, // M17d (Run D): the OC mode the apply runs under
 *                           // (the same value the caller's ocModeRefusal
 *                           // received) - threaded into splitByRuntime via
 *                           // applySettingsRouted (the V1-call pin)
 *   sysmanPowerLimits?: object | null, // M17f: the sysman PL2 companion
 *                           // consumer - forwarded to applySettingsRouted
 * }} deps
 * @returns {Promise<{ result: { ok: boolean, perControl: Record<string, unknown> }, state: object | null }>}
 */
export async function executeApply({ backend, oldIgcl, deviceId, settings, opts = {}, log = () => {}, delayedVerifyMs, sleep, ocMode = null, sysmanPowerLimits = null }) {
  const caps = await backend.getCapabilities(deviceId);
  // M3-C step-5 F1: advanced mode + a NOT-capable 2023 runtime (the
  // future-driver degradation) -> refuse extended values BEFORE the clamp,
  // never a silent 252 W / 90 C cap that reports ok:true. The capability
  // check is honest on both sides of the worker boundary. The refusal is a
  // config/capability refusal: the fresh state is read back (the device was
  // never touched) and no defaults-restore fallback runs downstream.
  // M4O: a profileApply keys this safety net on the RUNTIME capability
  // (oldIgcl.isCapable) instead of the mode-gated caps.extendedRanges - the
  // callers (applyProfile / the ipc-core profileApply path) gate first;
  // this is belt-and-suspenders for direct callers. Without it the
  // always-elevated packaged app's TRAY apply of a 315 W profile in stock
  // mode would refuse here (caps.extendedRanges is false in stock mode).
  const extendedCapable = opts.profileApply === true && oldIgcl
    ? await oldIgcl.isCapable()
    : caps.extendedRanges === true;
  const unavailable = extendedUnavailableRefusal(settings, { ...caps, extendedRanges: extendedCapable });
  if (unavailable) {
    log(`[apply] extended-unavailable refusal: ${unavailable.message} (${unavailable.controls.join(', ')}) - nothing applied`);
    let state = null;
    try { state = await backend.getCurrentSettings(deviceId); } catch { /* degraded */ }
    return { result: { ok: false, perControl: extendedUnavailablePerControl(unavailable.controls) }, state };
  }
  // M4O: the profileApply clamp uses the driver's TRUE limits
  // (extendedRangesFor) - the mode-gated caps.ranges would silently reduce
  // a saved 300 W profile to 252 W in a stock session.
  const clampRanges = opts.profileApply === true ? extendedRangesFor(caps) : caps.ranges;
  const clamped = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value === null || value === undefined) continue;
    const range = clampRanges[key];
    clamped[key] = range && typeof value === 'number'
      ? clampAndSnap(value, range)
      : value;
  }
  const out = await applySettingsRouted({ backend, oldIgcl, deviceId, settings: clamped, opts, log, delayedVerifyMs, sleep, ranges: caps.ranges, mode: ocMode, sysmanPowerLimits, limitsKey: { pciDeviceId: caps.pciDeviceId ?? null, aibVendor: caps.aibVendor ?? null, aibModel: caps.aibModel ?? null } });
  let state = null;
  try { state = await backend.getCurrentSettings(deviceId); } catch { /* degraded */ }

  // M26: always inspect the shared Sysman voltage domain for supported
  // V-unit devices with a finite backend voltage state. Only a finite
  // negative Sysman offset is authoritative for the overlay; positive/zero
  // read-back leaves the backend's IGCL value intact.
  if (caps.ranges?.gpuVoltOffsetV?.units === 'V'
    && Number.isFinite(state?.gpuVoltOffsetV)
    && typeof sysmanPowerLimits?.readVoltageOffset === 'function') {
    try {
      const voltRead = await sysmanPowerLimits.readVoltageOffset(deviceId);
      if (voltRead && typeof voltRead === 'object'
        && Number.isFinite(voltRead.offsetV)
        && voltRead.offsetV < 0) {
        state = { ...state, gpuVoltOffsetV: voltRead.offsetV };
      }
    } catch {
      // best-effort overlay - degraded to backend state
    }
  }

  return { result: out.result, state };
}

/**
 * A no-op old-runtime adapter (the DEFAULT for tests and mock mode): not
 * capable, setters answer with the honest unavailable message. Never loads
 * the DLL.
 */
export function createNullOldIgcl() {
  return {
    isCapable: async () => false,
    setPowerLimitW: async () => ({ ok: false, errorCode: 'unsupported', readBackEqual: false, message: EXTENDED_UNAVAILABLE_MSG }),
    setTempLimitC: async () => ({ ok: false, errorCode: 'unsupported', readBackEqual: false, message: EXTENDED_UNAVAILABLE_MSG }),
    close: async () => {},
  };
}
