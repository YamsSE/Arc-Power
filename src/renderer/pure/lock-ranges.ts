// Arc Power - M17e per-GPU gpuLock bounds fallback table (pure, DOM-free;
// unit-tested in test/pure-lock-ranges.test.ts).
//
// The caps.lockRange comes from the DRIVER PROPS FIRST (the runtime truth
// for EVERY card - ctl_oc_properties_t gpuVFCurveVoltageLimit /
// gpuVFCurveFrequencyLimit through the units decode, the Run-B plumbing).
// This table is the LISTED-CARD FALLBACK for devices whose driver does NOT
// report the range (the dev-box A770's driver answers bSupported:false /
// zeros - the probe-3 evidence, 2026-08-13):
//   - the A770 (0x56A0) + the A750 (0x56A1): the DOCUMENTED-CLASS row -
//     the app's documented absolute lock bounds (units.js GPU_LOCK_VOLT_MAX_V
//     1.5 V / GPU_LOCK_FREQ_MAX_MHZ 5000 MHz, the M4-B "documented ABSOLUTE
//     bounds") - the clamp behaves identically to the global fallback;
//   - the A380 (0x56A5) / A310 (0x56A6): NO documented lock bounds exist ->
//     null -> the global fallback (same bounds by construction);
//   - b580 / arc-igpu / pro-b50: null (no gpuLock control at all).
//
// A null return means "no listed bounds" - the caller (Run B's caps
// plumbing + the renderer) then uses the global documented fallback via
// clampGpuLock's absent-range path, which is exactly this row's shape.

import { A770_PCI_DEVICE_ID, A750_PCI_DEVICE_ID } from './device-limits.ts';
import type { LockRange } from '../types.ts';

/** The documented-class row: the app's documented ABSOLUTE lock bounds
 *  (units.js GPU_LOCK_VOLT_MAX_V / GPU_LOCK_FREQ_MAX_MHZ - the M4-B lock
 *  pair ceiling; the (0,0) dynamic pair stays reachable via the clamp's
 *  S2 bypass). Source: the app's documented bounds, NOT a driver props
 *  claim. */
const DOCUMENTED_CLASS: LockRange = Object.freeze({
  voltMin: 0,
  voltMax: 1.5,
  freqMin: 0,
  freqMax: 5000,
});

/** The A770's LIVE-PINNED lock range (2026-08-13 boundary probe,
 *  pipeline/live-gpulock-boundary.mjs, driver 0x00200000006522a0 - the user's
 *  (1.2 V, 2400 MHz) refusal was the trigger): the voltage sweep at 2400 MHz
 *  sticks 950/1000/1050/1100 mV and REFUSES 1150+ (0x44000002 -
 *  VOLTAGE_OUTSIDE_RANGE) -> the real voltMax is 1.1 V, NOT the documented
 *  1.5 V; the frequency sweep at 1100 mV sticks 2400/2500/2600/2700/2800/
 *  2900/3000 MHz (the sweep ceiling - the documented 5000 MHz is UNVERIFIED
 *  above 3000, kept as the documented-class ceiling with the honest note). */
const A770_LIVE: LockRange = Object.freeze({
  voltMin: 0,
  voltMax: 1.1, // probe-pinned: 1150 mV refused 0x44000002 on this driver
  freqMin: 0,
  freqMax: 5000, // documented-class; >= 3000 MHz live-verified (the sweep ceiling)
});

/** The listed rows (documented entries only; sources in the comments).
 *  Keyed on the canonical '0x0000xxxx' caps/DeviceInfo rendering like the
 *  device-limits table. */
const LISTED_ROWS: Record<string, LockRange> = {
  // The A770: 0x56A0 (the dev-box card). The boundary probe (2026-08-13)
  // pinned the REAL acceptance: voltMax 1.1 V (1150+ refused), freqMax >=
  // 3000 (the documented 5000 kept). The props report no VF limits
  // (probe-3: bSupported:false) so this row IS the A770's lock range.
  [A770_PCI_DEVICE_ID]: A770_LIVE,
  // The A750: 0x56A1. No gpuVFCurve-limit documentation exists in the
  // research corpus (arc-limits-research.md has no lock/VF-curve bounds) -
  // the documented-class row (the app's documented absolute lock bounds).
  // A future A750 live probe (the Acer tester's machine) can pin real
  // values here - the A770's 1.1 V is NOT assumed for the A750.
  [A750_PCI_DEVICE_ID]: DOCUMENTED_CLASS,
};

/**
 * The M17e per-GPU gpuLock bounds fallback row for a device (the caps
 * pciDeviceId, canonical '0x0000xxxx' shape - normalized case-insensitively).
 * Null when the card has no listed row (the A380/A310 have no DOCUMENTED
 * lock bounds -> the global documented fallback applies; b580/arc-igpu/
 * pro-b50 have no gpuLock control at all). The driver props stay the
 * runtime authority (caps.lockRange wins when present) - this table only
 * pins what is DOCUMENTED.
 * @param {string | null | undefined} pciDeviceId the caps pciDeviceId
 * @returns {LockRange | null}
 */
export function lockRangeOf(pciDeviceId: string | null | undefined): LockRange | null {
  if (typeof pciDeviceId !== 'string' || pciDeviceId.length === 0) return null;
  return LISTED_ROWS[pciDeviceId.toLowerCase()] ?? null;
}
