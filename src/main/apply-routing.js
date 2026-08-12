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
 * per-card KMD ceilings: A770 315/115, A750 270/115 - the A750 TL
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
 * - advanced: PL/TL up to the EXTENDED ceiling (315 W / 115 C - the live-verified KMD ceiling) are allowed;
 *             values above it refuse with the ceiling message - NEVER
 *             clamped (an above-ceiling write would be silently capped by
 *             the clamp layer, voiding the 400 W probe - live 2026-08-06: 315 W is the ceiling).
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
 * ceilings (A770 315/115, A750 270/115 - probe-verified 2026-08-12; the
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
 * (the extended W/C maxes EXTENDED_PL_MAX_W / EXTENDED_TL_MAX_C), NOT the
 * mode-gated caps.ranges (stock mode caps max at 252 W / 90 C - clamping a
 * profile there would silently reduce a saved 300 W profile to 252 W, the
 * "silent reduction reported as applied" class the codebase forbids).
 *
 * Overrides ONLY when the range key exists with the matching unit: a
 * W-unit device without a tempLimitC key yields undefined for it (no own
 * keys are added - the conditional spread never invents a key); percent-
 * unit devices (Battlemage) keep their own ranges (their max IS the
 * ceiling and splitByRuntime never routes them to the 2023 runtime).
 * Null-guarded - the helper is exported and standalone-tested.
 * @param {{ ranges?: Record<string, { units?: string }> } | null | undefined} caps
 * @returns {Record<string, unknown>}
 */
export function extendedRangesFor(caps) {
  const ranges = caps?.ranges ?? null;
  if (!ranges) return {};
  const out = { ...ranges };
  const pl = ranges.powerLimitW;
  if (pl && pl.units === 'W') out.powerLimitW = { ...pl, max: EXTENDED_PL_MAX_W };
  const tl = ranges.tempLimitC;
  if (tl && tl.units === 'C') out.tempLimitC = { ...tl, max: EXTENDED_TL_MAX_C };
  return out;
}

// The momentary-lie re-read delay (default 400 ms, injectable in tests).
export const DELAYED_VERIFY_MS = 400;

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
 * }} deps
 * @returns {Promise<{
 *   result: { ok: boolean, perControl: Record<string, { ok: boolean, errorCode?: string, message?: string, readBackEqual?: boolean, silentNoop?: boolean }> },
 *   attempts: number,
 * }>}
 */
export async function applySettingsRouted({ backend, oldIgcl, deviceId, settings, opts = {}, log = () => {}, delayedVerifyMs = DELAYED_VERIFY_MS, sleep = defaultSleep, ranges = null, mode = null }) {
  const { driverstore, extended } = splitByRuntime(settings, ranges, mode);
  const perControl = {};

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

  const ok = Object.keys(perControl).length === 0
    ? true
    : Object.values(perControl).every((p) => p.ok === true);
  return { result: { ok, perControl }, attempts: 1 };
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
 * }} deps
 * @returns {Promise<{ result: { ok: boolean, perControl: Record<string, unknown> }, state: object | null }>}
 */
export async function executeApply({ backend, oldIgcl, deviceId, settings, opts = {}, log = () => {}, delayedVerifyMs, sleep, ocMode = null }) {
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
  const out = await applySettingsRouted({ backend, oldIgcl, deviceId, settings: clamped, opts, log, delayedVerifyMs, sleep, ranges: caps.ranges, mode: ocMode });
  let state = null;
  try { state = await backend.getCurrentSettings(deviceId); } catch { /* degraded */ }
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
