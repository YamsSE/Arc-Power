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
 * M4-B: the documented ABSOLUTE ceiling for a gpuLock voltage (V). The lock
 * pair is an absolute voltage/frequency point (real locks sit ~0.7–1.2 V),
 * NOT a voltage OFFSET — the old clamp used the gpuVoltOffsetV.max (0.234 V,
 * an offset bound) which made any real lock impossible. This documented
 * ceiling (~1.5 V, well above any shipping Arc voltage) keeps defense-in-
 * depth: a user-typed value can never reach ctlOverclockGpuLockSet unbounded.
 * 0 V stays legal = "don't touch voltage" (the driver keeps the stock
 * voltage at the locked frequency).
 */
export const GPU_LOCK_VOLT_MAX_V = 1.5;

/**
 * Hard ceiling for the exposed temperature limit (M2C-A F3 PT fix). The A770
 * driver's OC properties report 60–90 °C, but applying a value above 90 is
 * refused with 0x44000005 (TEMPERATURE_OUTSIDE_RANGE) while the props may
 * drift on other driver versions — so the exposed max is pinned here and
 * applied by every backend + the renderer. Never expose/apply above this.
 */
export const TEMP_LIMIT_MAX_C = 90;

/**
 * Clamp a gpuLock pair to the DOCUMENTED ABSOLUTE bounds before it reaches
 * the driver (M4-B: the lock pair is an absolute VF point, not an offset —
 * the voltage bound is the absolute ceiling GPU_LOCK_VOLT_MAX_V, floor 0
 * ("don't touch voltage"), NEVER the gpuVoltOffsetV offset range):
 *   - voltageV -> [0, GPU_LOCK_VOLT_MAX_V];
 *   - freqMhz -> [0, GPU_LOCK_FREQ_MAX_MHZ].
 * Shared by every apply path (igcl-backend, mock-backend, ipc-core).
 * @param {{ voltageV: number, freqMhz: number }} lock
 * @returns {{ voltageV: number, freqMhz: number }}
 */
export function clampGpuLock(lock) {
  return {
    voltageV: Math.min(Math.max(0, lock.voltageV), GPU_LOCK_VOLT_MAX_V),
    freqMhz: Math.min(Math.max(0, lock.freqMhz), GPU_LOCK_FREQ_MAX_MHZ),
  };
}

/**
 * M4-B: format a GPU display name with its VRAM amount ("Intel Arc A770
 * 16 GB"), formatted ONCE at listDevices time by the backends (never per
 * render — every consumer reads device.name). Rules:
 *   - vramBytes null / 0 / missing -> the plain name (no suffix);
 *   - >= 1 GiB -> "X GB" (rounded down to whole GiB);
 *   - < 1 GiB -> "X MB" (rounded down to whole MiB).
 * @param {string} name
 * @param {number|null|undefined} vramBytes
 * @returns {string}
 */
export function formatDeviceName(name, vramBytes) {
  if (!name || !Number.isInteger(vramBytes) || vramBytes <= 0) return name;
  // M4-D (user, live-verified): the driver's qwMemorySize is the honest
  // source but carries a small reserved margin (the 8 GB A770 reports
  // ~7.91 GiB) — ROUND to the nearest whole GiB so the suffix matches the
  // card's actual size ("8 GB"), never a floored undershoot ("7 GB").
  // Values under 1 GiB stay whole-MiB (a 512 MiB card never rounds to
  // "1 GB").
  const gib = vramBytes >= 1024 * 1024 * 1024 ? Math.round(vramBytes / (1024 * 1024 * 1024)) : 0;
  if (gib >= 1) return `${name} ${gib} GB`;
  const mib = Math.floor(vramBytes / (1024 * 1024));
  return `${name} ${mib} MB`;
}
