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
/** M42: the Acer packaged bridge is restricted to a physical Intel Arc A770. */
export function hasAcerA770PciIdentity(physicalTarget, limitsKey = null) {
  const target = physicalTarget && typeof physicalTarget === 'object' ? physicalTarget : {};
  const limits = limitsKey && typeof limitsKey === 'object' ? limitsKey : {};
  const normalize = (value) => typeof value === 'string'
    ? value.toLowerCase().replace(/^0x/, '').replace(/^0+/, '') : '';
  const rawDevice = target.pciDeviceId ?? limits.pciDeviceId;
  const rawVendor = target.pciVendorId ?? limits.pciVendorId ?? limits.vendorId ?? limits.aibVendor;
  return normalize(rawDevice) === '56a0' && normalize(rawVendor) === '8086';
}

export function isAcerA770Target(physicalTarget, limitsKey = null) {
  const target = physicalTarget && typeof physicalTarget === 'object' ? physicalTarget : {};
  if (target.synthetic === true || target.backendKind === 'os' || target.identityAmbiguous === true) return false;
  // The native Sysman consumer resolves the first power domain. Require the
  // matching display-card ordinal 0; accepting a nonzero ordinal could mutate
  // a different adapter while the PCI IDs still look like an A770.
  if (target.displayCardIndex !== 0) return false;
  // PCI IDs are vendor-scoped. Missing vendor proof is not an authorization.
  return hasAcerA770PciIdentity(physicalTarget, limitsKey);
}

/** M42: only a validated parent context may authorize the packaged route. */
export function isInteractiveApplyContext(context) {
  return context?.applyContext === 'interactive'
    && typeof context.owner === 'string' && context.owner.length > 0
    && typeof context.token === 'string' && context.token.length >= 16
    && typeof context.requestId === 'string' && context.requestId.length >= 8
    && context.requestBinding === context.requestId;
}

export function acerBridgePowerRequest({ settings, mode, physicalTarget, limitsKey = null }) {
  return mode === OC_MODE_ADVANCED
    && typeof settings?.powerLimitW === 'number'
    && settings.powerLimitW > STD_PL_MAX_W
    && isAcerA770Target(physicalTarget, limitsKey);
}

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
// ok:true - a false success claim. The parent-side capability signal
// includes an installed bundled DLL so an unelevated UI can delegate; the
// elevated worker's backend derives caps from its authoritative isCapable()
// probe. It runs in all four apply paths AFTER getCapabilities and BEFORE
// any clamp:
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
 * never the mode - parent caps may use installed-runtime availability so an
 * unelevated apply can delegate, while the elevated worker's caps use its
 * authoritative isCapable() probe. This remains a capability refusal, not
 * the caps-keyed mode gate the plan forbids.
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
 *   oldIgcl?: { setPowerLimitW: (w: number, deviceId?: number, deviceKey?: string|null) => Promise<{ ok: boolean, errorCode?: string, message?: string, readBackEqual?: boolean }> } | null | undefined, // M17n round-2 S1: the re-V1 seam re-applies the request to the routed target; the bundled adapter refuses targets it cannot safely map
 *   deviceKey?: string|null, // stable PCI/BDF identity for the selected target
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
export async function runSysmanCompanion({ sysmanPowerLimits, requestedW, log = () => {}, backend = null, deviceId = 0, deviceKey = null, legacyDeviceKey = deviceKey, limitsKey = null, clampAdvanced = false, extendedW, sysmanPrimary = false, oldIgcl = null, sleep = defaultSleep, delayedVerifyMs = DELAYED_VERIFY_MS }) {
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
              reV1 = await callOldSetter(oldIgcl, 'setPowerLimitW', requestedW, deviceId, legacyDeviceKey);
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
 * A missing/degraded read is best-effort and does not block the IGCL path for
 * ordinary non-negative voltage requests. Lock requests pass `strict: true`:
 * they refuse when the prior Sysman state cannot be established, preserving the
 * zero-offset lock invariant. Once the read proves a negative offset is active,
 * a failed clear is an honest per-control refusal and the IGCL voltage write is
 * skipped.
 *
 * @param {{
 *   sysmanPowerLimits?: {
 *     readVoltageOffsetResult?: (deviceId?: number) => Promise<{ ok: boolean, targetV?: number, offsetV?: number, errorCode?: string, message?: string }>,
 *     readVoltageOffset?: (deviceId?: number) => Promise<{ offsetV?: number } | null>,
 *     setVoltageOffset?: (p: { offsetV: number }, deviceId?: number) => Promise<{ ok: boolean, errorCode?: string, message?: string }>,
 *   } | null,
 *   deviceId?: number,
 *   log?: (s: string) => void,
 *   strict?: boolean,
 * }} deps
 * @returns {Promise<{ ok: boolean, checked: boolean, errorCode?: string, message?: string }>}
 */
async function clearNegativeSysmanVoltage({ sysmanPowerLimits, deviceId, log = () => {}, strict = false }) {
  // With no Sysman consumer at all, there is no companion state that could
  // remain active; ordinary and lock requests may proceed through IGCL.
  if (!sysmanPowerLimits) return { ok: true, checked: false };
  const setter = typeof sysmanPowerLimits?.setVoltageOffset === 'function'
    ? sysmanPowerLimits.setVoltageOffset.bind(sysmanPowerLimits)
    : null;
  const bestEffortZeroClear = async (reason) => {
    if (!setter || strict) return;
    // One bounded cleanup attempt is enough to remove a stale helper-side
    // offset. Its result is deliberately non-authoritative: the positive
    // IGCL write must not be blocked by an unreadable companion.
    let timeoutId;
    try {
      const cleared = await Promise.race([
        setter({ offsetV: 0 }, deviceId),
        new Promise((resolve) => {
          timeoutId = setTimeout(() => resolve(null), 500);
        }),
      ]);
      if (cleared?.ok === true) {
        log(`[apply] sysman voltage: best-effort stale-state clear succeeded (${reason})`);
      } else {
        log(`[apply] sysman voltage: best-effort stale-state clear did not verify (${reason})`);
      }
    } catch {
      log(`[apply] sysman voltage: best-effort stale-state clear failed (${reason})`);
    } finally {
      clearTimeout(timeoutId);
    }
  };
  const readWithStatus = typeof sysmanPowerLimits?.readVoltageOffsetResult === 'function';
  let current;
  if (readWithStatus) {
    let status;
    try {
      status = await sysmanPowerLimits.readVoltageOffsetResult(deviceId);
    } catch (err) {
      // Ordinary non-negative requests keep the IGCL path authoritative when
      // the companion read degrades. A lock is different: without a readable
      // prior state, its zero-offset invariant cannot be established.
      if (strict) {
        const message = `gpuLock requires a readable Sysman voltage state before applying the zero-offset lock (${err instanceof Error ? err.message : String(err)})`;
        return { ok: false, checked: false, errorCode: 'io-failed', message };
      }
      await bestEffortZeroClear('read threw');
      return { ok: true, checked: false };
    }
    if (status?.ok !== true) {
      if (strict) {
        return {
          ok: false,
          checked: false,
          errorCode: status?.errorCode ?? 'io-failed',
          message: status?.message ?? 'gpuLock requires a readable Sysman voltage state before applying the zero-offset lock',
        };
      }
      // Sysman is only a companion cleanup path for ordinary non-negative
      // requests; the IGCL V2 setter remains authoritative.
      await bestEffortZeroClear('read unavailable');
      return { ok: true, checked: false };
    }
    current = status;
  } else {
    if (typeof sysmanPowerLimits?.readVoltageOffset !== 'function') {
      if (strict) {
        return {
          ok: false,
          checked: false,
          errorCode: 'unsupported',
          message: 'gpuLock requires a readable Sysman voltage state before applying the zero-offset lock',
        };
      }
      await bestEffortZeroClear('read unavailable');
      return { ok: true, checked: false };
    }
    if (!setter) {
      return strict
        ? {
            ok: false,
            checked: false,
            errorCode: 'unsupported',
            message: 'gpuLock requires a readable Sysman voltage state before applying the zero-offset lock',
          }
        : { ok: true, checked: false };
    }
    try {
      current = await sysmanPowerLimits.readVoltageOffset(deviceId);
    } catch (err) {
      if (strict) {
        const message = `gpuLock requires a readable Sysman voltage state before applying the zero-offset lock (${err instanceof Error ? err.message : String(err)})`;
        return { ok: false, checked: false, errorCode: 'io-failed', message };
      }
      await bestEffortZeroClear('read threw');
      return { ok: true, checked: false };
    }
  }
  if (strict && (!current || typeof current !== 'object'
    || !Number.isFinite(current.offsetV))) {
    return {
      ok: false,
      checked: false,
      errorCode: 'io-failed',
      message: 'gpuLock requires a readable Sysman voltage state before applying the zero-offset lock',
    };
  }
  if (!current || typeof current !== 'object' || !Number.isFinite(current.offsetV)) {
    await bestEffortZeroClear('state unreadable');
    return { ok: true, checked: false };
  }
  if (current.needsClear !== true && current.offsetV >= 0) {
    return { ok: true, checked: true };
  }
  try {
    const cleared = await setter?.({ offsetV: 0 }, deviceId);
    if (cleared?.ok === true) {
      log(`[apply] sysman voltage: cleared prior negative offset ${current.offsetV} V before the non-negative IGCL apply`);
      return { ok: true, checked: true };
    }
    if (!strict) {
      // Positive voltage is authoritative; a stale companion cleanup failure
      // must not turn a valid IGCL apply into an unavailable/refused apply.
      log(`[apply] sysman voltage: stale negative offset clear did not verify; continuing with the positive IGCL apply`);
      return { ok: true, checked: true };
    }
    return {
      ok: false,
      checked: true,
      errorCode: cleared?.errorCode ?? 'io-failed',
      message: cleared?.message ?? 'the prior negative sysman voltage offset could not be cleared',
    };
  } catch (err) {
    if (!strict) {
      log(`[apply] sysman voltage: stale negative offset clear failed; continuing with the positive IGCL apply`);
      return { ok: true, checked: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, checked: true, errorCode: 'io-failed', message };
  }
}
/**
 * Forward the selected target's stable key to the real old-runtime seam.
 * JavaScript one-/two-argument injected adapters harmlessly ignore extras,
 * preserving their historical signatures.
 */
async function callOldSetter(oldIgcl, method, value, deviceId, deviceKey) {
  const setter = oldIgcl?.[method];
  if (typeof setter !== 'function') {
    return { ok: false, errorCode: 'unsupported', message: EXTENDED_UNAVAILABLE_MSG };
  }
  return setter.call(oldIgcl, value, deviceId, deviceKey);
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
 * DriverStore controls use one instant attempt plus delayed verification.
 * Extended controls use the bundled old runtime and receive the selected
 * device's stable PCI/BDF key when the adapter supports the three-argument
 * seam.
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   oldIgcl: {
 *     isCapable: (deviceId?: number) => Promise<boolean>,
 *     setPowerLimitW: (w: number, deviceId?: number, deviceKey?: string|null) => Promise<object>,
 *     setTempLimitC: (c: number, deviceId?: number, deviceKey?: string|null) => Promise<object>,
 *   },
 *   deviceId: number,
 *   deviceKey?: string|null,
 *   settings: Record<string, unknown>,
 *   opts?: Record<string, unknown>,
 *   log?: (s: string) => void,
 *   delayedVerifyMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   ranges?: Record<string, { units?: string }> | null,
 *   mode?: string | null,
 *   sysmanPowerLimits?: object | null,
 *   limitsKey?: object | null,
 *   acerPackagedBridge?: { apply: (request: object) => Promise<object> } | null,
 *   allowAcerBridge?: boolean,
 *   acerPackagedApplyEnabled?: boolean,
 *   interactiveContext?: object | null,
 *   baseline?: object | null,
 *   currentSettings?: object | null,
 * }} deps
 */
async function applySettingsRoutedUnlocked({ backend, oldIgcl, deviceId, deviceKey = null, legacyDeviceKey = deviceKey, physicalTarget: routePhysicalTarget = null, settings, opts = {}, log = () => {}, delayedVerifyMs = DELAYED_VERIFY_MS, sleep = defaultSleep, ranges = null, mode = null, sysmanPowerLimits = null, limitsKey = null, acerPackagedBridge = null, allowAcerBridge = false, acerPackagedApplyEnabled = false, interactiveContext = null, baseline = null, currentSettings = null }) {
  const physicalTarget = opts.physicalTarget ?? routePhysicalTarget;
  const bridgeRequest = acerBridgePowerRequest({ settings, mode, physicalTarget, limitsKey });
  const bridgeContext = allowAcerBridge === true && isInteractiveApplyContext(interactiveContext);
  const bridgeInteractive = bridgeRequest && bridgeContext;
  const bridgeEnabled = bridgeInteractive && acerPackagedApplyEnabled === true;
  const bridgeRouted = bridgeEnabled && acerPackagedBridge && typeof acerPackagedBridge.apply === 'function';
  if (acerPackagedBridge?.isRecoveryRequired?.() === true) {
    const perControl = Object.fromEntries(Object.keys(settings ?? {}).map((key) => [key, {
      ok: false,
      readBackEqual: false,
      errorCode: 'recovery-required',
      message: 'Acer packaged bridge recovery is required before any control can be changed',
    }]));
    return { result: { ok: false, perControl }, attempts: 1 };
  }
  const bridgeRefusal = bridgeInteractive && !bridgeRouted;
  let bridgePreflightPair = null;
  let bridgeRecoveryBaseline = null;
  let routeRecoveryPrepared = false;
  let routeRecoveryPending = false;
  let bridgeReservation = null;
  let bridgeReservationReleased = false;
  let routeReservation = null;
  let bridgePreflightProfileCoreVoltage = null;
  const ambiguousAcerRequest = bridgeInteractive
    && acerPackagedApplyEnabled === true
    && mode === OC_MODE_ADVANCED
    && typeof settings?.powerLimitW === 'number'
    && settings.powerLimitW > STD_PL_MAX_W
    && hasAcerA770PciIdentity(physicalTarget, limitsKey)
    && !isAcerA770Target(physicalTarget, limitsKey);
  if (ambiguousAcerRequest) {
    log(`[apply] Acer packaged bridge refusal for ${settings.powerLimitW} W - physical display-card proof is missing`);
    return {
      result: {
        ok: false,
        perControl: {
          powerLimitW: {
            ok: false,
            readBackEqual: false,
            errorCode: 'target-mismatch',
            message: 'the Intel Arc A770 display-card index proof is unavailable; no controls changed',
          },
        },
      },
      attempts: 1,
    };
  }
  // The bridge preflight is deliberately read-only and must complete before
  // any DriverStore, Sysman voltage, temperature, or fan/VF write.
  if (bridgeRouted) {
    let bridgePreflight;
    if (typeof acerPackagedBridge.preflight !== 'function') {
      bridgePreflight = {
        ok: false,
        errorCode: 'acer-bridge-preflight-unavailable',
        message: 'Acer packaged bridge preflight is unavailable; no controls changed.',
      };
    } else {
      try {
        bridgePreflight = await acerPackagedBridge.preflight({
          deviceId,
          deviceKey,
          physicalTarget,
          requestedW: settings.powerLimitW,
          baseline,
          interactiveContext,
          allowAcerBridge: true,
          acerPackagedApplyEnabled: true,
        });
      } catch (error) {
        bridgePreflight = {
          ok: false,
          errorCode: 'acer-bridge-preflight-error',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    if (bridgePreflight?.ok !== true) {
      log(`[apply] Acer packaged bridge preflight refusal for ${settings.powerLimitW} W - no controls changed`);
      let reservationMessage = '';
      if (bridgeReservation) {
        try {
          const released = await acerPackagedBridge.releaseReservation(bridgeReservation);
          if (released?.ok !== true) {
            acerPackagedBridge.markRecoveryRequired?.();
            reservationMessage = `; ${released?.message ?? 'reservation release failed'}`;
          } else {
            bridgeReservation = null;
          }
        } catch (error) {
          acerPackagedBridge.markRecoveryRequired?.();
          reservationMessage = `; ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      return {
        result: {
          ok: false,
          perControl: {
            powerLimitW: {
              ok: false,
              readBackEqual: false,
              requestedW: settings.powerLimitW,
              errorCode: bridgePreflight?.errorCode ?? 'acer-bridge-preflight-failed',
              message: `${bridgePreflight?.message ?? 'Acer packaged bridge preflight failed; no controls changed.'}${reservationMessage}`,
            },
          },
        },
        attempts: 1,
      };
    }
    bridgePreflightPair = bridgePreflight.physicalPair;
    bridgePreflightProfileCoreVoltage = bridgePreflight.profileCoreVoltage ?? null;
  }
  // Reserve the shared Acer transaction lock after the read-only preflight.
  // Ordinary routed writes take the same lock without requiring Acer to be
  // closed; this prevents a second Arc Power process from changing hardware
  // while the bridge owns the rollback baseline and temporary files.
  if (bridgeRouted) {
    if (typeof acerPackagedBridge.reserve !== 'function') {
      return {
        result: {
          ok: false,
          perControl: {
            powerLimitW: {
              ok: false,
              readBackEqual: false,
              requestedW: settings.powerLimitW,
              errorCode: 'acer-bridge-reservation-unavailable',
              message: 'Acer packaged bridge reservation is unavailable; no controls changed.',
            },
          },
        },
        attempts: 1,
      };
    }
    const reservation = await acerPackagedBridge.reserve({
      requestId: interactiveContext?.requestId ?? null,
      requireAcerClosed: true,
    });
    if (reservation?.ok !== true) {
      return {
        result: {
          ok: false,
          perControl: {
            powerLimitW: {
              ok: false,
              readBackEqual: false,
              requestedW: settings.powerLimitW,
              errorCode: reservation?.errorCode ?? 'acer-bridge-reservation-failed',
              message: reservation?.message ?? 'Acer packaged bridge reservation failed; no controls changed.',
            },
          },
        },
        attempts: 1,
      };
    }
    bridgeReservation = reservation;
  } else if (!bridgeRefusal && acerPackagedBridge && typeof acerPackagedBridge.reserve === 'function') {
    const reservation = await acerPackagedBridge.reserve({
      requestId: interactiveContext?.requestId ?? null,
      requireAcerClosed: false,
    });
    if (reservation?.ok !== true) {
      const perControl = Object.fromEntries(Object.keys(settings ?? {}).map((key) => [key, {
        ok: false,
        readBackEqual: false,
        errorCode: reservation?.errorCode ?? 'acer-bridge-reservation-failed',
        message: reservation?.message ?? 'another Arc Power transaction is active; no controls changed',
      }]));
      return { result: { ok: false, perControl }, attempts: 1 };
    }
    routeReservation = reservation;
  }
  let bridgeApplyStarted = false;
  let bridgeCommitted = false;
  let bridgePairApplied = false;
  try {
  const { driverstore: allDriverstore, extended } = splitByRuntime(settings, ranges, mode);
  // An interactive Acer power request has no safe fallback. Refuse before
  // DriverStore, voltage, or fan/VF phases when the opt-in bridge is absent
  // or disabled; ordinary controls must not partially apply around it.
  if (bridgeRefusal) {
    const errorCode = acerPackagedBridge ? 'acer-bridge-disabled' : 'acer-bridge-unavailable';
    const message = acerPackagedBridge
      ? 'Acer packaged apply bridge is disabled; enable the experimental setting before applying extended A770 power.'
      : 'Acer packaged apply bridge is unavailable; extended A770 power was not changed.';
    log(`[apply] Acer packaged bridge refusal for ${settings.powerLimitW} W - no controls changed`);
    return {
      result: {
        ok: false,
        perControl: {
          powerLimitW: {
            ok: false,
            readBackEqual: false,
            errorCode,
            message,
            requestedW: settings.powerLimitW,
          },
        },
      },
      attempts: 1,
    };
  }
  // M41: only the explicit ADVANCED route uses the Acer phase split. The
  // mode-less threshold fallback retains its historical single driverstore
  // call, even when one W/C value happens to route to the bundled runtime.
  const hasExtendedControls = mode === OC_MODE_ADVANCED && Object.keys(extended).length > 0;
  const fanKeys = new Set(['fanMode', 'fanCurve', 'fixedFanPct', 'vfCurve']);
  const driverstore = {};
  const postFanDriverstore = {};
  for (const [key, value] of Object.entries(allDriverstore)) {
    if (hasExtendedControls && fanKeys.has(key)) postFanDriverstore[key] = value;
    else driverstore[key] = value;
  }
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

  const bridgeBaselineAfterDirect = async () => {
    if (!baseline || typeof baseline !== 'object') return null;
    let state = null;
    try {
      const observed = await backend.getCurrentSettings(deviceId);
      if (observed && typeof observed === 'object' && !Array.isArray(observed)) state = observed;
    } catch { /* post-direct state is mandatory for the bridge baseline */ }
    if (!state) return null;
    const coreVoltage = Object.fromEntries(
      ['gpuFreqOffsetMhz', 'gpuVoltOffsetV']
        .filter((key) => key in state && Number.isFinite(state[key]))
        .map((key) => [key, state[key]]),
    );
    const fan = Object.fromEntries(
      ['fanMode', 'fanCurve', 'fixedFanPct', 'vfCurve']
        .filter((key) => key in state)
        .map((key) => [key, state[key]]),
    );
    const tempLimitC = Number.isFinite(state.tempLimitC) ? state.tempLimitC : null;
    if (Object.keys(coreVoltage).length === 0 || Object.keys(fan).length === 0 || !Number.isFinite(tempLimitC)) return null;
    if (!bridgePreflightPair
      || !Number.isFinite(bridgePreflightPair.sustainedW) || !Number.isFinite(bridgePreflightPair.burstW)) return null;
    let freshPair = bridgePreflightPair;
    try {
      const readPair = sysmanPowerLimits?.readLimitsForTarget;
      if (typeof readPair === 'function') {
        freshPair = await readPair.call(sysmanPowerLimits, physicalTarget, deviceId);
        if (!freshPair
          || freshPair.sustainedW !== bridgePreflightPair.sustainedW
          || freshPair.burstW !== bridgePreflightPair.burstW) return null;
      }
    } catch { return null; }
    let currentSysmanVoltageOffsetV = null;
    if (sysmanVoltageOffsetCaptured) {
      currentSysmanVoltageOffsetV = await readSysmanVoltageOffset();
      if (!Number.isFinite(currentSysmanVoltageOffsetV)) return null;
    }
    return {
      ...baseline,
      ...state,
      power: { sustainedW: freshPair.sustainedW, burstW: freshPair.burstW },
      coreVoltage,
      fan,
      tempLimitC,
      ...(sysmanVoltageOffsetCaptured
        ? { sysmanVoltageOffsetV: currentSysmanVoltageOffsetV }
        : {}),
    };
  };

  let priorSysmanVoltageOffsetV = null;
  let sysmanVoltageOffsetCaptured = false;
  let sysmanVoltageExpectedV = null;
  const readSysmanVoltageOffset = async () => {
    try {
      if (typeof sysmanPowerLimits?.readVoltageOffsetResult === 'function') {
        const status = await sysmanPowerLimits.readVoltageOffsetResult(deviceId);
        if (status?.ok === true && Number.isFinite(status.offsetV)) return status.offsetV;
      } else if (typeof sysmanPowerLimits?.readVoltageOffset === 'function') {
        const state = await sysmanPowerLimits.readVoltageOffset(deviceId);
        if (Number.isFinite(state?.offsetV)) return state.offsetV;
      }
    } catch {}
    return null;
  };
  const restoreSysmanVoltageOffset = async () => {
    if (!sysmanVoltageOffsetCaptured) return { ok: true };
    if (typeof sysmanPowerLimits?.setVoltageOffset !== 'function') {
      return { ok: false, message: 'the prior Sysman voltage offset cannot be restored' };
    }
    try {
      const written = await sysmanPowerLimits.setVoltageOffset({ offsetV: priorSysmanVoltageOffsetV }, deviceId);
      if (written?.ok !== true) return { ok: false, message: written?.message ?? 'the prior Sysman voltage offset restore did not verify' };
      const observed = await readSysmanVoltageOffset();
      return Number.isFinite(observed) && nearlyEqual(observed, priorSysmanVoltageOffsetV)
        ? { ok: true }
        : { ok: false, message: 'the prior Sysman voltage offset restore read-back mismatched' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
  const restorePreBridgeBaseline = async (recoveryState = baseline) => {
    const settingsToRestore = {
      ...(recoveryState?.coreVoltage && typeof recoveryState.coreVoltage === 'object' ? recoveryState.coreVoltage : {}),
      ...(recoveryState?.fan && typeof recoveryState.fan === 'object' ? recoveryState.fan : (recoveryState?.fanState ?? {})),
      ...(Number.isFinite(recoveryState?.tempLimitC) ? { tempLimitC: recoveryState.tempLimitC } : {}),
    };
    for (const key of new Set([...Object.keys(driverstore), ...Object.keys(postFanDriverstore)])) {
      if (key !== 'powerLimitW' && recoveryState?.[key] !== undefined) settingsToRestore[key] = recoveryState[key];
    }
    const restored = await applyOnce({ backend, deviceId, settings: settingsToRestore, opts, log });
    if (restored?.result?.ok === false) return { ok: false, message: 'pre-bridge rollback write failed' };
    let state;
    try { state = await backend.getCurrentSettings(deviceId); } catch { return { ok: false, message: 'pre-bridge rollback read-back unavailable' }; }
    if (!Object.entries(settingsToRestore).every(([key, value]) => JSON.stringify(state?.[key]) === JSON.stringify(value))) {
      return { ok: false, message: 'pre-bridge rollback read-back mismatch' };
    }
    const voltageRestored = await restoreSysmanVoltageOffset();
    if (!voltageRestored.ok) return voltageRestored;
    return { ok: true };
  };
  const restoreBridgePowerPair = async () => {
    const pair = bridgePreflightPair;
    const setter = sysmanPowerLimits?.setLimitsForTarget;
    const reader = sysmanPowerLimits?.readLimitsForTarget;
    const assertTarget = backend?.assertDeviceTarget;
    if (!pair || typeof setter !== 'function' || typeof reader !== 'function') {
      return { ok: false, message: 'the pre-bridge Sysman power pair cannot be restored' };
    }
    if (typeof assertTarget !== 'function') {
      return { ok: false, message: 'the pre-bridge Sysman target assertion is unavailable' };
    }
    try {
      await assertTarget.call(backend, deviceId, deviceKey, physicalTarget);
      const written = await setter.call(sysmanPowerLimits, physicalTarget, pair, deviceId);
      if (written?.ok !== true) return { ok: false, message: written?.message ?? 'the pre-bridge Sysman power pair restore failed' };
      await assertTarget.call(backend, deviceId, deviceKey, physicalTarget);
      const observed = await reader.call(sysmanPowerLimits, physicalTarget, deviceId);
      return observed?.sustainedW === pair.sustainedW && observed?.burstW === pair.burstW
        ? { ok: true }
        : { ok: false, message: 'the pre-bridge Sysman power pair restore read-back mismatched' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
  const assertAcerQuiescent = async (phase) => {
    if (typeof acerPackagedBridge?.assertQuiescent !== 'function') return { ok: true };
    try {
      const result = await acerPackagedBridge.assertQuiescent();
      return result?.ok === false
        ? { ok: false, message: result.message ?? `Acer process appeared during ${phase}` }
        : { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
  const verifyAcerRollbackState = async (recoveryState = bridgeRecoveryBaseline ?? baseline) => {
    const quietBefore = await assertAcerQuiescent('rollback verification');
    if (!quietBefore?.ok) return { ok: false, message: quietBefore.message ?? 'Acer process appeared during rollback verification' };
    let state;
    try {
      state = await backend.getCurrentSettings(deviceId);
    } catch {
      return { ok: false, message: 'rollback final state read-back unavailable' };
    }
    const expected = {
      ...(recoveryState?.coreVoltage && typeof recoveryState.coreVoltage === 'object' ? recoveryState.coreVoltage : {}),
      ...(recoveryState?.fan && typeof recoveryState.fan === 'object' ? recoveryState.fan : (recoveryState?.fanState ?? {})),
      ...(Number.isFinite(recoveryState?.tempLimitC) ? { tempLimitC: recoveryState.tempLimitC } : {}),
    };
    for (const key of new Set([...Object.keys(driverstore), ...Object.keys(postFanDriverstore)])) {
      if (key !== 'powerLimitW' && recoveryState?.[key] !== undefined) expected[key] = recoveryState[key];
    }
    if (!Object.entries(expected).every(([key, value]) => JSON.stringify(state?.[key]) === JSON.stringify(value))) {
      return { ok: false, message: 'rollback final state read-back mismatch' };
    }
    if (sysmanVoltageOffsetCaptured) {
      const observedVoltage = await readSysmanVoltageOffset();
      if (!Number.isFinite(observedVoltage) || !nearlyEqual(observedVoltage, priorSysmanVoltageOffsetV)) {
        return { ok: false, message: 'rollback final Sysman voltage offset read-back mismatched' };
      }
    }
    if (sysmanPowerLimits) {
      const reader = sysmanPowerLimits.readLimitsForTarget;
      const assertTarget = backend?.assertDeviceTarget;
      if (!bridgePreflightPair || typeof reader !== 'function' || typeof assertTarget !== 'function') {
        return { ok: false, message: 'rollback final Sysman power-pair verification is unavailable' };
      }
      try {
        await assertTarget.call(backend, deviceId, deviceKey, physicalTarget);
        const observedPair = await reader.call(sysmanPowerLimits, physicalTarget, deviceId);
        if (observedPair?.sustainedW !== bridgePreflightPair.sustainedW
          || observedPair?.burstW !== bridgePreflightPair.burstW) {
          return { ok: false, message: 'rollback final Sysman power-pair read-back mismatched' };
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    }
    const quietAfter = await assertAcerQuiescent('rollback verification');
    return quietAfter?.ok
      ? { ok: true }
      : { ok: false, message: quietAfter.message ?? 'Acer process appeared after rollback verification' };
  };
  const releaseBridgeReservation = async ({ clearRecovery = false } = {}) => {
    if (!bridgeReservation) return { ok: true };
    if (typeof acerPackagedBridge?.releaseReservation !== 'function') {
      acerPackagedBridge?.markRecoveryRequired?.();
      return { ok: false, message: 'Acer packaged bridge reservation release is unavailable' };
    }
    try {
      const released = await acerPackagedBridge.releaseReservation({
        ...bridgeReservation,
        retainRecoveryOnFailure: clearRecovery && routeRecoveryPrepared,
      });
      if (released?.ok !== true) {
        acerPackagedBridge?.markRecoveryRequired?.();
        return released ?? { ok: false, message: 'Acer packaged bridge reservation release failed' };
      }
      bridgeReservation = null;
      return released;
    } catch (error) {
      acerPackagedBridge?.markRecoveryRequired?.();
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
  const releaseRouteReservation = async () => {
    if (!routeReservation) return { ok: true };
    if (typeof acerPackagedBridge?.releaseReservation !== 'function') {
      return { ok: false, message: 'Acer transaction reservation release is unavailable' };
    }
    try {
      const released = await acerPackagedBridge.releaseReservation(routeReservation);
      if (released?.ok === true) routeReservation = null;
      return released?.ok === true ? released : (released ?? { ok: false, message: 'Acer transaction reservation release failed' });
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
  const persistRouteRecovery = async (recoveryBaseline = bridgeRecoveryBaseline ?? baseline) => {
    const persist = acerPackagedBridge?.persistRecovery;
    if (typeof persist !== 'function') return { ok: false, message: 'durable Acer route recovery is unavailable' };
    const durableBaseline = {
      ...(recoveryBaseline && typeof recoveryBaseline === 'object' ? recoveryBaseline : {}),
      ...(bridgePreflightPair ? { power: bridgePreflightPair } : {}),
      ...(bridgePreflightProfileCoreVoltage ? { coreVoltageProfile: bridgePreflightProfileCoreVoltage } : {}),
      ...(sysmanVoltageOffsetCaptured && Number.isFinite(priorSysmanVoltageOffsetV)
        ? { sysmanVoltageOffsetV: priorSysmanVoltageOffsetV }
        : {}),
    };
    try {
      return await persist.call(acerPackagedBridge, {
        deviceId,
        deviceKey,
        physicalTarget,
        baseline: durableBaseline,
        requestedW: settings?.powerLimitW,
        requestId: interactiveContext?.requestId ?? null,
      });
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
  const prepareRouteRecovery = async () => {
    const prepare = acerPackagedBridge?.prepareRouteRecovery;
    if (typeof prepare !== 'function') return { ok: true, durable: false };
    const recoveryBaseline = {
      ...(baseline && typeof baseline === 'object' ? baseline : {}),
      ...(bridgePreflightProfileCoreVoltage ? { coreVoltageProfile: bridgePreflightProfileCoreVoltage } : {}),
      ...(bridgePreflightPair ? { power: bridgePreflightPair } : {}),
      ...(sysmanVoltageOffsetCaptured && Number.isFinite(priorSysmanVoltageOffsetV)
        ? { sysmanVoltageOffsetV: priorSysmanVoltageOffsetV }
        : {}),
    };
    try {
      return await prepare.call(acerPackagedBridge, {
        deviceId,
        deviceKey,
        physicalTarget,
        baseline: recoveryBaseline,
        requestedW: settings?.powerLimitW,
        requestId: interactiveContext?.requestId ?? null,
        reservation: bridgeReservation,
      });
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
  const clearPreparedRouteRecovery = async () => {
    const clear = acerPackagedBridge?.clearPreparedRouteRecovery;
    if (typeof clear !== 'function') return { ok: false, message: 'durable Acer route recovery cleanup is unavailable' };
    try {
      return await clear.call(acerPackagedBridge, {
        reservation: bridgeReservation,
        requestId: interactiveContext?.requestId ?? null,
      });
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
  const clearRouteRecovery = async (reservation = bridgeReservation) => {
    const clear = acerPackagedBridge?.clearRouteRecovery;
    if (typeof clear !== 'function') return { ok: false, message: 'durable Acer route recovery cleanup is unavailable' };
    try {
      return await clear.call(acerPackagedBridge, {
        ownerNonce: reservation?.ownerNonce ?? null,
        requestId: interactiveContext?.requestId ?? null,
      });
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
  const releaseBridgeReservationAndClearRecovery = async () => {
    if (routeRecoveryPrepared) {
      const cleared = await clearPreparedRouteRecovery();
      if (cleared?.ok !== true) return cleared ?? { ok: false, message: 'durable route recovery cleanup failed' };
    }
    const released = await releaseBridgeReservation({ clearRecovery: true });
    if (released?.ok === true && routeRecoveryPrepared) routeRecoveryPrepared = false;
    return released;
  };


  const perControl = {};
  const markBridgeWriteFailure = (phase, keys = [], detail = null) => {
    routeRecoveryPending = true;
    acerPackagedBridge?.markRecoveryRequired?.();
    const failure = {
      ok: false,
      readBackEqual: false,
      errorCode: 'recovery-required',
      message: `${detail ?? `Acer process state could not be proven quiet before ${phase}`}; recovery is required`,
    };
    for (const key of keys) perControl[key] = failure;
    if (!perControl.powerLimitW) perControl.powerLimitW = failure;
    return failure;
  };
  const checkBridgeWriteBoundary = async (phase, keys = []) => {
    if (!bridgeRouted) return { ok: true };
    const quiet = await assertAcerQuiescent(phase);
    if (!quiet.ok) {
      markBridgeWriteFailure(phase, keys, quiet.message);
      return quiet;
    }
    return { ok: true };
  };
  const verifyAcerPostApplyState = async () => {
    if (!bridgeRouted) return { ok: true };
    let quiet;
    try {
      quiet = typeof acerPackagedBridge?.assertQuiescent === 'function'
        ? await acerPackagedBridge.assertQuiescent()
        : { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (!quiet?.ok) return { ok: false, message: quiet?.message ?? 'Acer process appeared before final verification' };
    if (typeof backend?.assertDeviceTarget === 'function') {
      try {
        await backend.assertDeviceTarget(deviceId, deviceKey, physicalTarget);
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    }
    let state;
    try {
      state = await backend.getCurrentSettings(deviceId);
      if (!state || typeof state !== 'object') return { ok: false, message: 'final Acer state read-back was unavailable' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    const expectedState = {
      ...Object.fromEntries(Object.entries(driverstore).filter(([key]) => key !== 'powerLimitW' && key !== 'gpuLock')),
      ...Object.fromEntries(Object.entries(postFanDriverstore).filter(([key]) => key !== 'powerLimitW' && key !== 'gpuLock')),
      ...(Object.prototype.hasOwnProperty.call(extended, 'tempLimitC') ? { tempLimitC: extended.tempLimitC } : {}),
    };
    for (const [key, value] of Object.entries(expectedState)) {
      if (perControl[key]?.ok !== true) continue;
      if (JSON.stringify(state[key]) !== JSON.stringify(value)) {
        return { ok: false, message: `final Acer ${key} read-back mismatched the requested value` };
      }
    }
    if (sysmanVoltageOffsetCaptured && Number.isFinite(sysmanVoltageExpectedV)) {
      const observedVoltage = await readSysmanVoltageOffset();
      if (!Number.isFinite(observedVoltage) || !nearlyEqual(observedVoltage, sysmanVoltageExpectedV)) {
        return { ok: false, message: `final Acer Sysman voltage offset read-back mismatched (${observedVoltage ?? '?'} V; expected ${sysmanVoltageExpectedV} V)` };
      }
    }
    const reader = typeof sysmanPowerLimits?.readLimitsForTarget === 'function'
      ? sysmanPowerLimits.readLimitsForTarget.bind(sysmanPowerLimits)
      : typeof acerPackagedBridge?.readLimitsForTarget === 'function'
        ? acerPackagedBridge.readLimitsForTarget.bind(acerPackagedBridge)
        : null;
    if (!reader) return { ok: false, message: 'final Acer power-pair read-back is unavailable' };
    let observed;
    try {
      observed = await reader(physicalTarget, deviceId);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (!Number.isFinite(observed?.sustainedW) || !Number.isFinite(observed?.burstW)
      || observed.sustainedW !== settings.powerLimitW
      || observed.burstW !== settings.powerLimitW) {
      return {
        ok: false,
        message: `final Acer power-pair read-back mismatched (${observed?.sustainedW ?? '?'} / ${observed?.burstW ?? '?'} W; requested ${settings.powerLimitW} W)`,
      };
    }
    try {
      const finalQuiet = typeof acerPackagedBridge?.assertQuiescent === 'function'
        ? await acerPackagedBridge.assertQuiescent()
        : { ok: true };
      return finalQuiet?.ok
        ? { ok: true }
        : { ok: false, message: finalQuiet?.message ?? 'Acer process appeared during final verification' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
  const failAcerVoltagePrecondition = async (failure) => {
    if (!bridgeRouted) return null;
    let cleanupIssue = null;
    const restored = await restoreSysmanVoltageOffset();
    if (!restored.ok) cleanupIssue = restored.message ?? 'the prior Sysman voltage offset could not be restored';
    if (!cleanupIssue) {
      const cleaned = await releaseBridgeReservationAndClearRecovery();
      if (cleaned?.ok !== true) cleanupIssue = cleaned?.message ?? 'Acer bridge cleanup failed';
    }
    if (cleanupIssue) acerPackagedBridge?.markRecoveryRequired?.();
    const resultFailure = {
      ...failure,
      readBackEqual: false,
      ...(cleanupIssue ? {
        errorCode: 'recovery-required',
        message: `${failure.message ?? 'Acer voltage precondition failed'}; ${cleanupIssue}; recovery is required`,
      } : {}),
    };
    perControl.powerLimitW = resultFailure;
    return { result: { ok: false, perControl }, attempts: 1 };
  };
  const runAcerBridge = async () => {
    if (bridgeRefusal) {
      perControl.powerLimitW = {
        ok: false,
        message: acerPackagedBridge
          ? 'Acer packaged apply bridge is disabled; enable the experimental setting before applying extended A770 power.'
          : 'Acer packaged apply bridge is unavailable; extended A770 power was not changed.',
      };
      log(`[apply] Acer packaged bridge refusal for ${settings.powerLimitW} W - nothing changed`);
    } else if (bridgeRouted) {
      let bridgeResult;
      const bridgeBaseline = await bridgeBaselineAfterDirect();
      bridgeRecoveryBaseline = bridgeBaseline;
      if (!bridgeBaseline) {
        bridgeResult = {
          ok: false,
          requestedW: settings.powerLimitW,
          observed: null,
          errorCode: 'readback-unavailable',
          message: 'Acer packaged apply requires a verified post-direct core/voltage/fan/temperature/power state',
          rollback: { ok: true, untouched: true },
        };
        acerPackagedBridge?.markRecoveryRequired?.();
        await releaseBridgeReservation();
      } else {
        try {
          bridgeApplyStarted = true;
          bridgeResult = await acerPackagedBridge.apply({
            deviceId,
            deviceKey,
            physicalTarget,
            requestedW: settings.powerLimitW,
            temperatureC: typeof settings.tempLimitC === 'number' ? settings.tempLimitC : currentSettings?.tempLimitC,
            baseline: bridgeBaseline,
            currentSettings: bridgeBaseline,
            log,
            allowAcerBridge: true,
            acerPackagedApplyEnabled: true,
            interactiveContext,
            leaveRequestedPair: true,
            reservation: bridgeReservation,
            retainReservation: true,
          });
        } catch (err) {
          bridgeApplyStarted = false;
          if (acerPackagedBridge?.isRecoveryRequired?.() === true) {
            routeRecoveryPending = true;
          } else {
            const released = await releaseBridgeReservation();
            if (released?.ok !== true) routeRecoveryPending = true;
          }
          bridgeResult = {
            ok: false,
            requestedW: settings.powerLimitW,
            observed: null,
            errorCode: 'acer-bridge-error',
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }
      const finalPairResult = bridgeResult;
      const bridgeRollbackReleased = finalPairResult?.rollback?.ok === true
        && finalPairResult?.rollback?.untouched !== true;
      if (bridgeRollbackReleased) bridgeReservationReleased = true;
      const observed = finalPairResult?.observed;
      const observedEqual = Number.isFinite(observed?.sustainedW)
        && Number.isFinite(observed?.burstW)
        && observed.sustainedW === settings.powerLimitW
        && observed.burstW === settings.powerLimitW;
      const bridgePairOk = finalPairResult?.ok === true && observedEqual;
      perControl.powerLimitW = {
        ...(finalPairResult && typeof finalPairResult === 'object' ? finalPairResult : {}),
        ok: bridgePairOk,
        readBackEqual: bridgePairOk,
        requestedW: settings.powerLimitW,
        ...(!bridgePairOk && finalPairResult?.ok === true
          ? { errorCode: 'readback-mismatch', message: 'Acer packaged bridge did not verify the requested power pair' }
          : {}),
      };
      bridgeCommitted = bridgePairOk;
      bridgePairApplied = bridgePairOk;
      const bridgeUntouched = finalPairResult?.rollback?.untouched === true;
      const bridgeCleanupVerified = finalPairResult?.rollback?.ok === true;
      if (perControl.powerLimitW.ok !== true && (bridgeCleanupVerified || bridgeUntouched)) {
        const durableRoutePending = routeRecoveryPrepared
          && !bridgeReservation
          && !bridgeApplyStarted
          && acerPackagedBridge?.isRecoveryRequired?.() === true;
        if (durableRoutePending) {
          routeRecoveryPending = true;
          perControl.powerLimitW.errorCode = 'recovery-required';
          perControl.powerLimitW.message = `${perControl.powerLimitW.message ?? 'Acer packaged bridge failed'}; durable route recovery is pending`;
        } else {
          const bridgeQuiet = await assertAcerQuiescent('baseline rollback');
          if (!bridgeQuiet.ok) {
            routeRecoveryPending = true;
            perControl.powerLimitW.errorCode = 'recovery-required';
            perControl.powerLimitW.message = `${perControl.powerLimitW.message ?? 'Acer packaged bridge failed'}; ${bridgeQuiet.message ?? 'Acer process appeared before baseline rollback'}`;
            acerPackagedBridge?.markRecoveryRequired?.();
          } else {
            let restored = await restorePreBridgeBaseline(bridgeRecoveryBaseline ?? baseline);
            if (restored.ok) {
              const verified = await verifyAcerRollbackState(bridgeRecoveryBaseline ?? baseline);
              if (!verified.ok) restored = { ok: false, message: verified.message ?? 'final Acer rollback verification failed' };
            }
            if (restored.ok && routeRecoveryPrepared && bridgeReservationReleased) {
              const cleared = await clearRouteRecovery(bridgeReservation);
              if (!cleared.ok) restored = { ok: false, message: cleared.message ?? 'durable Acer route recovery cleanup failed' };
            }
            if (!restored.ok) {
              routeRecoveryPending = true;
              let durable = null;
              if (!routeRecoveryPrepared) {
                durable = await persistRouteRecovery(bridgeRecoveryBaseline ?? baseline);
                if (durable?.ok !== true) acerPackagedBridge?.markRecoveryRequired?.();
              }
              perControl.powerLimitW.message = `${perControl.powerLimitW.message ?? 'Acer packaged bridge failed'}; ${restored.message}${durable?.message ? `; ${durable.message}` : ''}`;
              perControl.powerLimitW.errorCode = 'recovery-required';
          }
        }
        }
      } else if (perControl.powerLimitW.ok !== true && !bridgeCleanupVerified) {
        routeRecoveryPending = true;
        perControl.powerLimitW.errorCode = 'recovery-required';
        perControl.powerLimitW.message = `${perControl.powerLimitW.message ?? 'Acer packaged bridge cleanup failed'}; recovery is required before further writes`;
      }
    }
    if (perControl.powerLimitW?.ok !== true) acerPowerFailed = true;
    acerPowerRouted = true;
  };

  const applyDriverstore = async (controls) => {
    if (Object.keys(controls).length === 0) return;
    log(`[apply] driverstore controls: [${Object.keys(controls).join(', ')}] (single attempt)`);
    const out = await applyOnce({ backend, deviceId, settings: controls, opts, log });
    Object.assign(perControl, out.result.perControl);

    // Momentary-lie guard for each driverstore phase: re-read mismatches once
    // after the delay. A match = the write persisted (lagging read-back);
    // still mismatched = honest fail.
    const candidates = Object.keys(controls).filter((key) => isMomentaryLieCandidate(perControl[key]));
    if (candidates.length > 0) {
      log(`[apply] delayed re-read for [${candidates.join(', ')}] after ${delayedVerifyMs} ms (momentary-lie guard)`);
      await sleep(delayedVerifyMs);
      let state = null;
      try { state = await backend.getCurrentSettings(deviceId); } catch { /* degraded re-read */ }
      if (state) {
        for (const key of candidates) {
          const wanted = controls[key];
          const got = state[key];
          if (typeof wanted === 'number' && typeof got === 'number' && nearlyEqual(got, wanted)) {
            log(`[apply] delayed re-read MATCHED ${key} (${got}) - write persisted`);
            perControl[key] = { ok: true, readBackEqual: true };
          }
        }
      }
    }
  };
  const abortAcerBeforeBridge = async () => {
    if (!bridgeRouted) return null;
    const failedControls = [
      ...Object.keys(driverstore),
      ...Object.keys(extended).filter((key) => key !== 'powerLimitW'),
    ].filter((key) => key !== 'powerLimitW' && perControl[key]?.ok !== true);
    if (failedControls.length === 0) return null;
    const failedNames = failedControls.join(', ');
    let cleanupIssue = null;
    let bridgeQuiet = { ok: true };
    try {
      if (typeof acerPackagedBridge?.assertQuiescent === 'function') {
        bridgeQuiet = await acerPackagedBridge.assertQuiescent();
      }
    } catch (error) {
      cleanupIssue = error instanceof Error ? error.message : String(error);
    }
    if (!cleanupIssue && !bridgeQuiet.ok) {
      cleanupIssue = bridgeQuiet.message ?? 'Acer process appeared before direct rollback';
    }
    if (!cleanupIssue) {
      try {
        const restored = await restorePreBridgeBaseline(bridgeRecoveryBaseline ?? baseline);
        if (!restored.ok) cleanupIssue = restored.message ?? 'pre-bridge rollback failed';
      } catch (error) {
        cleanupIssue = error instanceof Error ? error.message : String(error);
      }
    }
    if (!cleanupIssue && typeof acerPackagedBridge?.assertQuiescent === 'function') {
      try {
        const finalQuiet = await acerPackagedBridge.assertQuiescent();
        if (!finalQuiet?.ok) cleanupIssue = finalQuiet?.message ?? 'Acer process appeared before direct cleanup commit';
      } catch (error) {
        cleanupIssue = error instanceof Error ? error.message : String(error);
      }
    }
    if (!cleanupIssue) {
      const verified = await verifyAcerRollbackState(bridgeRecoveryBaseline ?? baseline);
      if (!verified.ok) cleanupIssue = verified.message ?? 'final Acer rollback verification failed';
    }
    if (!cleanupIssue) {
      const cleaned = await releaseBridgeReservationAndClearRecovery();
      if (cleaned?.ok !== true) {
        cleanupIssue = cleaned?.message ?? 'Acer bridge cleanup failed';
      }
    }
    const cleanupOk = !cleanupIssue;
    let durable = null;
    if (!cleanupOk && !routeRecoveryPrepared) {
      durable = await persistRouteRecovery(bridgeRecoveryBaseline ?? baseline);
      if (durable?.ok !== true) acerPackagedBridge?.markRecoveryRequired?.();
    }
    perControl.powerLimitW = {
      ok: false,
      readBackEqual: false,
      errorCode: cleanupOk ? 'pre-bridge-failed' : 'recovery-required',
      message: `Acer power was not started because direct control(s) failed: ${failedNames}${cleanupOk ? '' : `; ${cleanupIssue}; recovery is required${durable?.message ? `; ${durable.message}` : ''}`}`,
    };
    return { result: { ok: false, perControl }, attempts: 1 };
  };


  let acerPowerFailed = false;
  let acerPowerRouted = false;

  // Non-negative voltage requests clear the prior Sysman companion only after
  // the packaged transaction has passed its all-or-nothing preflight.
  const lockRequestsOffsetZero = !!(settings.gpuLock && typeof settings.gpuLock === 'object');
  const nonNegativeVoltOffsetV = typeof settings.gpuVoltOffsetV === 'number' && settings.gpuVoltOffsetV >= 0
    ? settings.gpuVoltOffsetV
    : undefined;
  const sysmanVoltageMayChange = bridgeRouted && sysmanPowerLimits
    && (negativeVoltOffsetV !== undefined || nonNegativeVoltOffsetV !== undefined || lockRequestsOffsetZero);
  if (sysmanVoltageMayChange) {
    priorSysmanVoltageOffsetV = await readSysmanVoltageOffset();
    sysmanVoltageExpectedV = priorSysmanVoltageOffsetV;
    if (!Number.isFinite(priorSysmanVoltageOffsetV)) {
      await releaseBridgeReservation();
      return {
        result: {
          ok: false,
          perControl: {
            powerLimitW: {
              ok: false,
              readBackEqual: false,
              errorCode: 'readback-unavailable',
              message: 'the prior Sysman voltage offset could not be captured before the Acer transaction',
            },
          },
        },
        attempts: 1,
      };
    }
    sysmanVoltageOffsetCaptured = true;
  }
  if (bridgeRouted && !routeRecoveryPrepared) {
    const armed = await prepareRouteRecovery();
    const durableReady = armed?.ok === true
      && armed?.durable !== false
      && typeof acerPackagedBridge?.prepareRouteRecovery === 'function';
    if (!durableReady) {
      const released = await releaseBridgeReservation();
      const releaseMessage = released?.ok === true ? '' : `; ${released?.message ?? 'reservation release failed'}`;
      return {
        result: {
          ok: false,
          perControl: {
            powerLimitW: {
              ok: false,
              readBackEqual: false,
              errorCode: armed?.errorCode ?? 'recovery-required',
              message: `${armed?.message ?? 'durable Acer route recovery could not be armed; no controls changed'}${releaseMessage}`,
            },
          },
        },
        attempts: 1,
      };
    }
    routeRecoveryPrepared = true;
  }
  if (voltageIsVUnit && (nonNegativeVoltOffsetV !== undefined || lockRequestsOffsetZero)) {
    const voltageBoundary = await checkBridgeWriteBoundary('the Sysman voltage clear', ['gpuVoltOffsetV', ...(lockRequestsOffsetZero ? ['gpuLock'] : [])]);
    if (!voltageBoundary.ok) return { result: { ok: false, perControl }, attempts: 1 };
    const clear = await clearNegativeSysmanVoltage({ sysmanPowerLimits, deviceId, log, strict: lockRequestsOffsetZero || bridgeRouted });
    if (clear.ok && priorSysmanVoltageOffsetV < 0) sysmanVoltageExpectedV = 0;
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
      if (bridgeRouted) {
        const aborted = await failAcerVoltagePrecondition(failure);
        if (aborted) return aborted;
      }
    }
  }

  // Negative Sysman voltage is verified before any direct control write so
  // the Acer bridge never runs with an unverified voltage precondition.
  if (negativeVoltOffsetV !== undefined && typeof sysmanPowerLimits?.setVoltageOffset === 'function') {
    const voltageBoundary = await checkBridgeWriteBoundary('the Sysman voltage write', ['gpuVoltOffsetV']);
    if (!voltageBoundary.ok) return { result: { ok: false, perControl }, attempts: 1 };
    const voltResult = await runSysmanVoltageOffset({ sysmanPowerLimits, offsetV: negativeVoltOffsetV, deviceId, log });
    const failure = voltResult.ok === true
      ? null
      : { ok: false, errorCode: voltResult.errorCode ?? 'io-failed', message: voltResult.message ?? 'the sysman voltage offset write did not verify' };
    perControl.gpuVoltOffsetV = failure ?? { ok: true, readBackEqual: true };
    if (!failure) {
      sysmanVoltageExpectedV = Number.isFinite(voltResult.offsetV)
        ? voltResult.offsetV
        : Math.max(SAFE_VOLT_OFFSET_MIN_V, negativeVoltOffsetV);
    }
    if (failure && bridgeRouted) {
      const aborted = await failAcerVoltagePrecondition(failure);
      if (aborted) return aborted;
    }
  } else if (negativeVoltOffsetV !== undefined) {
    const failure = { ok: false, errorCode: 'unsupported', message: 'negative gpuVoltOffsetV requires the sysman voltage offset setter' };
    perControl.gpuVoltOffsetV = failure;
    if (bridgeRouted) {
      const aborted = await failAcerVoltagePrecondition(failure);
      if (aborted) return aborted;
    }
  }
  if (bridgeRouted && Object.keys(driverstore).length > 0) {
    const driverstoreBoundary = await checkBridgeWriteBoundary('the direct control write', Object.keys(driverstore));
    if (!driverstoreBoundary.ok) return { result: { ok: false, perControl }, attempts: 1 };
  }
  await applyDriverstore(driverstore);
  const preBridgeAbort = await abortAcerBeforeBridge();
  if (preBridgeAbort) return preBridgeAbort;

  if (Object.keys(extended).length > 0) {
    log(`[apply] extended controls: [${Object.keys(extended).join(', ')}] via the bundled 2023 IGCL runtime`);
    // M41: the Acer path is deterministic regardless of payload key order.
    for (const key of ['tempLimitC', 'powerLimitW']) {
      if (!(key in extended)) continue;
      const value = extended[key];
      if (key === 'powerLimitW' && (bridgeRouted || bridgeRefusal)) {
        if (!acerPowerRouted) await runAcerBridge();
        continue;
      }
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
          ? await callOldSetter(oldIgcl, 'setPowerLimitW', value, deviceId, legacyDeviceKey)
          : await callOldSetter(oldIgcl, 'setTempLimitC', value, deviceId, legacyDeviceKey);
      } else {
        per = { ok: false, errorCode: 'unsupported', message: EXTENDED_UNAVAILABLE_MSG };
      }
      perControl[key] = per;
      if (key === 'tempLimitC' && per?.ok !== true && bridgeRouted) {
        const aborted = await abortAcerBeforeBridge();
        if (aborted) return aborted;
      }
      if (per?.ok !== true && bridgeRouted) continue;
      if (key === 'tempLimitC' && (bridgeRouted || bridgeRefusal) && !acerPowerRouted) {
        await runAcerBridge();
      }
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
  if (acerPowerFailed) {
    log('[apply] skipping requested fan/VF phase because the Acer power transaction did not complete cleanly');
  } else {
    if (bridgeRouted && Object.keys(postFanDriverstore).length > 0) {
      const postFanBoundary = await checkBridgeWriteBoundary('the post-fan control write', Object.keys(postFanDriverstore));
      if (!postFanBoundary.ok) return { result: { ok: false, perControl }, attempts: 1 };
    }
    await applyDriverstore(postFanDriverstore);
    const postFanFailed = acerPowerRouted
      && Object.keys(postFanDriverstore).some((key) => perControl[key]?.ok !== true);
    if (postFanFailed) {
      routeRecoveryPending = true;
      const bridgeQuiet = await assertAcerQuiescent('post-fan rollback');
      let restored = { ok: false, message: bridgeQuiet.message ?? 'Acer process appeared before post-fan rollback' };
      if (bridgeQuiet.ok) {
        try { restored = await restorePreBridgeBaseline(bridgeRecoveryBaseline ?? baseline); } catch (error) {
          restored = { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
      }
      const pairRestored = restored.ok ? await restoreBridgePowerPair() : { ok: false, message: 'the core/fan rollback did not complete' };
      const rollbackVerified = restored.ok && pairRestored.ok
        ? await verifyAcerRollbackState(bridgeRecoveryBaseline ?? baseline)
        : { ok: false, message: 'the core/fan rollback did not complete' };
      if (restored.ok && pairRestored.ok && rollbackVerified.ok) {
        routeRecoveryPending = false;
        bridgePairApplied = false;
        perControl.powerLimitW = {
          ...(perControl.powerLimitW ?? {}),
          ok: false,
          readBackEqual: false,
          errorCode: 'post-fan-rollback',
          message: 'Acer power was rolled back because the requested fan/VF phase did not verify',
        };
      } else {
        acerPackagedBridge?.markRecoveryRequired?.();
        perControl.powerLimitW = {
          ...(perControl.powerLimitW ?? {}),
          ok: false,
          readBackEqual: false,
          errorCode: 'recovery-required',
          message: `post-fan rollback failed; recovery is required${restored.message ? `: ${restored.message}` : ''}${pairRestored.message ? `; ${pairRestored.message}` : ''}${rollbackVerified.message ? `; ${rollbackVerified.message}` : ''}`,
        };
      }
    }
  }

  // M17g/M40: PL2 note tracking. Stock IGCL writes retain their historical
  // primary-V2 note. Advanced bundled V1 writes are authoritative for PL1:
  // the official pair marks PL2 verified, while scalar compatibility leaves
  // PL2 unknown. The known PL1-only V2 companion is never run after an
  // advanced bundled write; the Sysman companion below remains independent
  // and may replace the note only after its own pair read-back.
  const plUnits = ranges?.powerLimitW?.units;
  const wUnits = plUnits === undefined || plUnits === 'W';
  let pl2Note = null;
  if (typeof settings.powerLimitW === 'number' && wUnits && perControl.powerLimitW?.ok === true) {
    if (extended.powerLimitW !== undefined) {
      // Bundled V1 writes are authoritative for PL1. A paired result verifies
      // PL2; the scalar compatibility result leaves PL2 unknown. Never run
      // the known PL1-only V2 companion after either bundled V1 write.
      pl2Note = {
        landed: perControl.powerLimitW.pairedReadBack === true,
        valueW: settings.powerLimitW,
        ...(perControl.powerLimitW.pairedReadBack === true ? {} : { unknown: true }),
      };
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
  if (!acerPowerRouted && !bridgeRefusal && sysmanPrimary) {
    if (sysmanPowerLimits && wUnits) {
      const sysmanNote = await runSysmanCompanion({
        sysmanPowerLimits,
        requestedW: settings.powerLimitW,
        log,
        backend,
        deviceId,
        deviceKey,
        legacyDeviceKey,
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
  } else if (!acerPowerRouted && !bridgeRefusal && typeof settings.powerLimitW === 'number' && perControl.powerLimitW?.ok === true && sysmanPowerLimits && wUnits) {
    const sysmanNote = await runSysmanCompanion({
      sysmanPowerLimits,
      requestedW: settings.powerLimitW,
      log,
      backend,
      deviceId,
      deviceKey,
      legacyDeviceKey,
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
  if (acerPowerRouted && perControl.powerLimitW?.ok === true) {
    pl2Note = { landed: true, valueW: settings.powerLimitW };
  }


  if (bridgeReservation) {
    let canRelease = !routeRecoveryPending && !bridgeReservationReleased;
    if (canRelease && bridgePairApplied) {
      const finalState = await verifyAcerPostApplyState();
      if (finalState?.ok !== true) {
        canRelease = false;
        routeRecoveryPending = true;
        acerPackagedBridge?.markRecoveryRequired?.();
        perControl.powerLimitW = {
          ...(perControl.powerLimitW ?? {}),
          ok: false,
          readBackEqual: false,
          errorCode: 'recovery-required',
          message: `${perControl.powerLimitW?.message ?? 'Acer packaged bridge final verification failed'}; ${finalState?.message ?? 'final target-bound state verification failed'}`,
        };
      }
    }
    // Clear the prepared route journal while the reservation still owns the
    // writer lock. A release failure then retains/re-writes that journal.
    if (canRelease) {
      const cleaned = await releaseBridgeReservationAndClearRecovery();
      if (cleaned?.ok !== true) {
        canRelease = false;
        routeRecoveryPending = true;
        acerPackagedBridge?.markRecoveryRequired?.();
        perControl.powerLimitW = {
          ...(perControl.powerLimitW ?? {}),
          ok: false,
          readBackEqual: false,
          errorCode: 'recovery-required',
          message: `${perControl.powerLimitW?.message ?? 'Acer packaged bridge cleanup failed'}; ${cleaned?.message ?? 'reservation release failed; route recovery was retained'}`,
        };
      }
    }
  }
  if (routeReservation) {
    const released = await releaseRouteReservation();
    if (released?.ok !== true) {
      for (const key of Object.keys(settings ?? {})) {
        perControl[key] = {
          ...(perControl[key] ?? {}),
          ok: false,
          readBackEqual: false,
          errorCode: 'recovery-required',
          message: `${perControl[key]?.message ?? 'apply completed but transaction cleanup failed'}; ${released?.message ?? 'reservation release failed'}`,
        };
      }
    }
  }
  const ok = Object.keys(perControl).length === 0
    ? true
    : Object.values(perControl).every((p) => p.ok === true);
  return { result: { ok, perControl, pl2Note }, attempts: 1 };
  } catch (error) {
    if (bridgeCommitted) {
      const bridgeQuiet = await assertAcerQuiescent('post-bridge rollback');
      let restored = { ok: false, message: bridgeQuiet.message ?? 'Acer process appeared before post-bridge rollback' };
      if (bridgeQuiet.ok) {
        try {
          restored = await restorePreBridgeBaseline(bridgeRecoveryBaseline ?? baseline);
        } catch (restoreError) {
          restored = { ok: false, message: restoreError instanceof Error ? restoreError.message : String(restoreError) };
        }
      }
      const pairRestored = bridgeQuiet.ok && restored.ok
        ? await restoreBridgePowerPair()
        : { ok: false, message: 'the core/fan rollback did not complete' };
      const rollbackVerified = bridgeQuiet.ok && restored.ok && pairRestored.ok
        ? await verifyAcerRollbackState(bridgeRecoveryBaseline ?? baseline)
        : { ok: false, message: 'the core/fan rollback did not complete' };
      let cleanupOk = bridgeQuiet.ok && restored.ok && pairRestored.ok && rollbackVerified.ok;
      if (!rollbackVerified.ok && restored.ok) restored = { ok: false, message: rollbackVerified.message };
      if (cleanupOk) {
        const cleaned = await releaseBridgeReservationAndClearRecovery();
        cleanupOk = cleaned?.ok === true;
        if (!cleanupOk) restored = { ok: false, message: cleaned?.message ?? 'Acer bridge cleanup failed' };
      }
      let durable = null;
      if (!cleanupOk && !routeRecoveryPrepared) {
        durable = await persistRouteRecovery(bridgeRecoveryBaseline ?? baseline);
        if (durable?.ok !== true) acerPackagedBridge?.markRecoveryRequired?.();
      }
      return {
        result: {
          ok: false,
          perControl: {
            powerLimitW: {
              ok: false,
              readBackEqual: false,
              errorCode: cleanupOk ? 'apply-error' : 'recovery-required',
              message: `${error instanceof Error ? error.message : String(error)}${cleanupOk ? '' : `; bridge success cleanup requires recovery${durable?.message ? `: ${durable.message}` : ''}`}`,
            },
          },
        },
        attempts: 1,
      };
    }
    if (bridgeReservation && !bridgeApplyStarted) {
      const bridgeQuiet = await assertAcerQuiescent('direct rollback');
      let restored = { ok: false, message: bridgeQuiet.message ?? 'Acer process appeared before direct rollback' };
      if (bridgeQuiet.ok) {
        try { restored = await restorePreBridgeBaseline(); } catch (restoreError) {
          restored = { ok: false, message: restoreError instanceof Error ? restoreError.message : String(restoreError) };
        }
      }
      const rollbackVerified = bridgeQuiet.ok && restored.ok
        ? await verifyAcerRollbackState(bridgeRecoveryBaseline ?? baseline)
        : { ok: false, message: 'direct rollback did not complete' };
      let cleanupIssue = !bridgeQuiet.ok
        ? (bridgeQuiet.message ?? 'Acer process appeared before direct rollback')
        : !restored.ok
          ? restored.message
          : !rollbackVerified.ok
            ? rollbackVerified.message
            : null;
      const recoveryBaseline = bridgeRecoveryBaseline ?? baseline;
      let durable = null;
      if (!cleanupIssue) {
        const cleaned = await releaseBridgeReservationAndClearRecovery();
        if (cleaned?.ok !== true) cleanupIssue = cleaned?.message ?? 'Acer bridge cleanup failed';
      }
      if (cleanupIssue && !routeRecoveryPrepared) {
        durable = await persistRouteRecovery(recoveryBaseline);
        if (durable?.ok !== true) acerPackagedBridge?.markRecoveryRequired?.();
      }
      const cleanupOk = !cleanupIssue;
      return {
        result: {
          ok: false,
          perControl: {
            powerLimitW: {
              ok: false,
              readBackEqual: false,
              errorCode: cleanupOk ? 'apply-error' : 'recovery-required',
              message: `${error instanceof Error ? error.message : String(error)}${cleanupOk ? '' : `; ${cleanupIssue}; recovery is required${durable?.message ? `: ${durable.message}` : ''}`}`,
            },
          },
        },
        attempts: 1,
      };
    }
    if (routeReservation) {
      const released = await releaseRouteReservation();
      const perControl = Object.fromEntries(Object.keys(settings ?? {}).map((key) => [key, {
        ok: false,
        readBackEqual: false,
        errorCode: released?.ok === true ? 'apply-error' : 'recovery-required',
        message: `${error instanceof Error ? error.message : String(error)}${released?.ok === true ? '' : `; ${released?.message ?? 'reservation release failed'}`}`,
      }]));
      return { result: { ok: false, perControl }, attempts: 1 };
    }
    throw error;
  }
}
let routedApplyTail = Promise.resolve();
export async function applySettingsRouted(args) {
  const previous = routedApplyTail;
  let release;
  routedApplyTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await applySettingsRoutedUnlocked(args);
  } finally {
    release();
  }
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
export async function executeApply({ backend, oldIgcl, deviceId, deviceKey: expectedDeviceKey = null, physicalTarget = null, settings, opts = {}, log = () => {}, delayedVerifyMs, sleep, ocMode = null, sysmanPowerLimits = null, acerPackagedBridge = null, allowAcerBridge = false, acerPackagedApplyEnabled = false, interactiveContext = null }) {
  if (typeof backend.assertDeviceTarget === 'function') {
    await backend.assertDeviceTarget(deviceId, expectedDeviceKey, physicalTarget);
  }
  const caps = await backend.getCapabilities(deviceId);
  // M30: an OS-only inventory entry is a valid read/telemetry target but is
  // never a write target.  This guard sits before Sysman/IGCL routing so a
  // profile, tray apply, boot apply, or elevated worker cannot touch a
  // different adapter as a fallback.
  if (caps?.overclockingSupported === false) {
    const perControl = {};
    for (const key of Object.keys(settings ?? {})) {
      perControl[key] = { ok: false, errorCode: 'unsupported', message: 'overclocking is not supported on this GPU' };
    }
    let state = null;
    try { state = await backend.getCurrentSettings(deviceId); } catch { /* honest null */ }
    return { result: { ok: Object.keys(perControl).length === 0, perControl }, state };
  }
  // M30: the inventory's durable key is PNP-first, while OldIgcl selects
  // against its own PCI/BDF enumeration. The physical proof carries the
  // legacy key across both the in-process and elevated-worker boundaries;
  // never feed the PNP key into the legacy setter.
  const legacyDeviceKey = typeof physicalTarget?.legacyDeviceKey === 'string'
    ? physicalTarget.legacyDeviceKey
    : expectedDeviceKey;
  const limitsKey = {
    pciDeviceId: caps.pciDeviceId ?? null,
    aibVendor: caps.aibVendor ?? null,
    aibModel: caps.aibModel ?? null,
  };
  const bridgeRequest = acerBridgePowerRequest({ settings, mode: ocMode, physicalTarget, limitsKey });
  const bridgeInteractive = bridgeRequest
    && allowAcerBridge === true
    && isInteractiveApplyContext(interactiveContext);
  const ambiguousAcerRequest = allowAcerBridge === true
    && acerPackagedApplyEnabled === true
    && ocMode === OC_MODE_ADVANCED
    && typeof settings?.powerLimitW === 'number'
    && settings.powerLimitW > STD_PL_MAX_W
    && hasAcerA770PciIdentity(physicalTarget, limitsKey)
    && !isAcerA770Target(physicalTarget, limitsKey);
  if (ambiguousAcerRequest) {
    let state = null;
    try { state = await backend.getCurrentSettings(deviceId); } catch { /* degraded */ }
    return {
      result: {
        ok: false,
        perControl: {
          powerLimitW: {
            ok: false,
            readBackEqual: false,
            errorCode: 'target-mismatch',
            message: 'the Intel Arc A770 display-card index proof is unavailable; no controls changed',
          },
        },
      },
      state,
    };
  }
  // Capture and validate the complete rollback baseline before any routed
  // phase. A failed read is a refusal, never permission to mutate first and
  // hope that the bridge can capture a post-write substitute.
  let baseline = null;
  let baselineState = null;
  if (bridgeInteractive) {
    try { baselineState = await backend.getCurrentSettings(deviceId); } catch { baselineState = null; }
    if (baselineState && typeof baselineState === 'object' && !Array.isArray(baselineState)) {
      const coreVoltage = Object.fromEntries(
        ['gpuFreqOffsetMhz', 'gpuVoltOffsetV'].filter((key) => key in baselineState).map((key) => [key, baselineState[key]]),
      );
      const fan = Object.fromEntries(
        ['fanMode', 'fanCurve', 'fixedFanPct', 'vfCurve'].filter((key) => key in baselineState).map((key) => [key, baselineState[key]]),
      );
      const temperatureC = baselineState.tempLimitC ?? baselineState.temperatureLimitC;
      const coreOk = Object.keys(coreVoltage).length > 0 && Object.values(coreVoltage).every((value) => Number.isFinite(value));
      const fanOk = Object.keys(fan).length > 0;
      const temperatureOk = Number.isFinite(temperatureC);
      if (coreOk && fanOk && temperatureOk) {
        baseline = { ...baselineState, coreVoltage, fan, tempLimitC: temperatureC };
      }
    }
    if (!baseline) {
      return {
        result: {
          ok: false,
          perControl: {
            powerLimitW: {
              ok: false,
              readBackEqual: false,
              errorCode: 'readback-unavailable',
              message: 'Acer packaged apply requires a complete pre-write rollback baseline; no controls changed',
            },
          },
        },
        state: baselineState,
      };
    }
  }
  // future-driver degradation) -> refuse extended values BEFORE the clamp,
  // never a silent 252 W / 90 C cap that reports ok:true. The capability
  // check is honest on both sides of the worker boundary. The refusal is a
  // config/capability refusal: the fresh state is read back (the device was
  // never touched) and no defaults-restore fallback runs downstream.
  // M4O/M41: the profileApply and interactive safety nets both use the
  // authoritative runtime probe whenever an adapter exists.  Installed-DLL
  // presence is only a parent-side delegation signal; it must never prove
  // in-process write capability.  Keep the caps fallback for null/test
  // adapters that intentionally omit the runtime seam.
  let extendedCapable = caps.extendedRanges === true;
  if (oldIgcl && typeof oldIgcl.isCapable === 'function') {
    try { extendedCapable = await oldIgcl.isCapable(); } catch { extendedCapable = false; }
  }
  const unavailable = extendedUnavailableRefusal(settings, { ...caps, extendedRanges: extendedCapable });
  const unavailableControls = unavailable?.controls?.filter((key) => !(bridgeInteractive && key === 'powerLimitW')) ?? [];
  if (unavailableControls.length > 0) {
    log(`[apply] extended-unavailable refusal: ${unavailable.message} (${unavailableControls.join(', ')}) - nothing applied`);
    let state = null;
    try { state = await backend.getCurrentSettings(deviceId); } catch { /* degraded */ }
    return { result: { ok: false, perControl: extendedUnavailablePerControl(unavailableControls) }, state };
  }
  // M4O: the profileApply clamp uses the driver's TRUE limits
  const clampRanges = opts.profileApply === true || bridgeInteractive ? extendedRangesFor(caps) : caps.ranges;
  const clamped = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value === null || value === undefined) continue;
    const range = clampRanges[key];
    clamped[key] = range && typeof value === 'number'
      ? clampAndSnap(value, range)
      : value;
  }
  const out = await applySettingsRouted({
    backend,
    oldIgcl,
    deviceId,
    deviceKey: expectedDeviceKey,
    legacyDeviceKey,
    physicalTarget,
    settings: clamped,
    opts,
    log,
    delayedVerifyMs,
    sleep,
    ranges: caps.ranges,
    mode: ocMode,
    sysmanPowerLimits,
    acerPackagedBridge,
    allowAcerBridge,
    acerPackagedApplyEnabled,
    interactiveContext,
    baseline,
    currentSettings: baseline,
  });
  let state = null;
  try { state = await backend.getCurrentSettings(deviceId); } catch { /* degraded */ }
  // Positive-only voltage UI: never replace the IGCL state with a legacy
  // negative Sysman companion value.
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
