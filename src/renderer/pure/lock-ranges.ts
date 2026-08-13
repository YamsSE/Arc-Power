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

/** The listed rows (documented entries only; sources in the comments).
 *  Keyed on the canonical '0x0000xxxx' caps/DeviceInfo rendering like the
 *  device-limits table. */
const LISTED_ROWS: Record<string, LockRange> = {
  // The A770: 0x56A0 (the dev-box card). The probe-3 live evidence
  // (2026-08-13, pipeline/live-gpulock-probe3.mjs, driver
  // 0x00200000006522a0): ctlOverclockGetProperties reports BOTH
  // gpuVFCurveVoltageLimit and gpuVFCurveFrequencyLimit as bSupported:false
  // + zeros - the driver exposes NO lock range, so the row carries the
  // documented-class bounds (the clamp then behaves exactly like the global
  // fallback). The row EXISTS so the caps plumbing + the renderer resolve
  // the same bounds for the listed card without special-casing.
  [A770_PCI_DEVICE_ID]: DOCUMENTED_CLASS,
  // The A750: 0x56A1. No gpuVFCurve-limit documentation exists in the
  // research corpus (arc-limits-research.md has no lock/VF-curve bounds) -
  // the documented-class row (the app's documented absolute lock bounds).
  // A future A750 live probe can pin real values here.
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
