// Arc Power — M1 canonical-unit conversion + range helpers.
//
// IGCL capability entries carry a `units` field (see CTL_UNITS in
// igcl-bindings.js). The V2 OC API follows those units — power can be W or
// mW, voltage V or mV, frequency MHz or GTS/MTS — while Settings fields are
// pinned to canonical units (W, V, MHz, GTS, C, %). These helpers convert
// and clamp; both real and mock backends snap applies to capability steps.

import { CTL_UNITS } from './igcl-bindings.js';

/**
 * Canonical unit string for a CTL_UNITS value.
 * @param {number} units CTL_UNITS value from ctl_oc_control_info_t
 * @returns {string}
 */
export function canonicalUnit(units) {
  switch (units) {
    case 0: return 'MHz';
    case 1: return 'GTS';
    case 2: return 'MTS';
    case 3: return 'V';
    case 4: return 'W';
    case 5: return 'C';
    case 10: return 'mW';
    case 13: return 'mV';
    case 11: return '%';
    case 9: return 'RPM';
    default: return CTL_UNITS[units] ?? `UNITS_${units}`;
  }
}

/**
 * Convert a canonical value to the IGCL API value for the given CTL_UNITS
 * (capability units). No-op when units match the canonical ones.
 * @param {number} value canonical value
 * @param {number} units CTL_UNITS value
 * @returns {number}
 */
export function canonicalToIgcl(value, units) {
  switch (units) {
    case 10: return value * 1000; // W -> mW
    case 13: return value * 1000; // V -> mV
    case 2: return value * 1000; // GTS -> MTS
    case 3: case 0: case 1: case 4: case 5: case 11: case 9:
      return value;
    default:
      return value;
  }
}

/**
 * Convert an IGCL API value (in capability units) to canonical units.
 * @param {number} value IGCL value
 * @param {number} units CTL_UNITS value
 * @returns {number}
 */
export function igclToCanonical(value, units) {
  switch (units) {
    case 10: return value / 1000; // mW -> W
    case 13: return value / 1000; // mV -> V
    case 2: return value / 1000; // MTS -> GTS
    default:
      return value;
  }
}

/**
 * Snap a value to the nearest multiple of `step` from `min`, then clamp to
 * [min, max]. Preserves min/max bounds exactly (step may not divide the
 * range evenly).
 * @param {number} value
 * @param {{ min: number, max: number, step: number }} range
 * @returns {number}
 */
export function clampAndSnap(value, range) {
  const { min, max, step } = range;
  if (!Number.isFinite(value)) return min;
  let snapped;
  if (step > 0) {
    snapped = min + Math.round((value - min) / step) * step;
    // Floating-point drift guard (e.g. 0.005 steps accumulate 0.0050000..1).
    snapped = Math.round(snapped / step) * step;
  } else {
    snapped = value;
  }
  return Math.min(max, Math.max(min, snapped));
}

/**
 * True when `a` and `b` are equal within the float tolerance of a step.
 * @param {number} a
 * @param {number} b
 * @param {number} [eps]
 * @returns {boolean}
 */
export function nearlyEqual(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

/**
 * Clamp a fan speed percentage to [0, 100] (whole %).
 * @param {number} pct
 * @returns {number}
 */
export function clampFanPct(pct) {
  return Math.min(100, Math.max(0, Math.round(pct)));
}

/**
 * Normalize a fan curve into a driver-ready table: clamp the point count to
 * `maxPoints` (0/absent -> 32, the ctl_fan_speed_table_t cap), round temps
 * to whole °C, clamp speeds to 0..100 %, sort by temp, then enforce
 * strictly ascending temps (IGCL requires an ascending table; duplicate
 * temps are bumped forward by 1 °C). Mirrors pure/curve.ts
 * enforceAscending so IgclBackend and MockBackend accept identical payloads
 * (mock<->real drift guard).
 * @param {Array<{ t: number, speedPct: number }>} points
 * @param {number} maxPoints
 * @returns {Array<{ t: number, speedPct: number }>}
 */
export function normalizeFanCurve(points, maxPoints) {
  const cap = maxPoints > 0 ? maxPoints : 32;
  const table = points
    .slice(0, cap)
    .map((p) => ({ t: Math.round(p.t), speedPct: clampFanPct(p.speedPct) }))
    .sort((a, b) => a.t - b.t);
  for (let i = 1; i < table.length; i++) {
    if (table[i].t <= table[i - 1].t) table[i] = { ...table[i], t: table[i - 1].t + 1 };
  }
  return table;
}

/**
 * Documented sane ceiling for the gpuLock frequency (absolute MHz lock).
 * IGCL exposes no capability range for the lock pair, so both main and the
 * backends share this ceiling — far above any shipping Arc clock.
 */
export const GPU_LOCK_FREQ_MAX_MHZ = 5000;

/**
 * Clamp a gpuLock pair to sane bounds before it reaches the driver:
 *   - voltageV -> [0, gpuVoltOffsetV.max] when that range exists (the only
 *     documented voltage bound available; absolute lock voltages outside it
 *     are refused, and 0 is the legal "don't touch voltage" lock value);
 *   - freqMhz -> [0, GPU_LOCK_FREQ_MAX_MHZ] always.
 * @param {{ voltageV: number, freqMhz: number }} lock
 * @param {Record<string, { min: number, max: number, step: number }>} [ranges]
 * @returns {{ voltageV: number, freqMhz: number }}
 */
export function clampGpuLock(lock, ranges = {}) {
  const voltRange = ranges.gpuVoltOffsetV;
  return {
    voltageV: voltRange
      ? Math.min(Math.max(0, lock.voltageV), voltRange.max)
      : lock.voltageV,
    freqMhz: Math.min(Math.max(0, lock.freqMhz), GPU_LOCK_FREQ_MAX_MHZ),
  };
}
