// Arc Power - M1 canonical-unit conversion + range helpers.
//
// IGCL capability entries carry a `units` field (see CTL_UNITS in
// igcl-bindings.js). The V2 OC API follows those units - power can be W or
// mW, voltage V or mV, frequency MHz or GTS/MTS - while Settings fields are
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
 * backends share this ceiling - far above any shipping Arc clock.
 */
export const GPU_LOCK_FREQ_MAX_MHZ = 5000;

/**
 * M4-B: the documented ABSOLUTE ceiling for a gpuLock voltage (V). The lock
 * pair is an absolute voltage/frequency point (real locks sit ~0.7–1.2 V),
 * NOT a voltage OFFSET - the old clamp used the gpuVoltOffsetV.max (0.234 V,
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
 * drift on other driver versions - so the exposed max is pinned here and
 * applied by every backend + the renderer. Never expose/apply above this.
 */
export const TEMP_LIMIT_MAX_C = 90;

/**
 * Clamp a gpuLock pair to the DOCUMENTED ABSOLUTE bounds before it reaches
 * the driver (M4-B: the lock pair is an absolute VF point, not an offset -
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
 * M4-I (S1 - ONE contract): the Intel memory-type tokens that map to GDDR6.
 * A-series (Alchemist: A310/A350/A370/A380/A580/A750/A770) + B-series
 * (Battlemage: B570/B580/B60 + the Arc Pro B50 - its fixture's 'b50' token
 * must resolve so the pro-b50 never renders "12GB" bare while b580 renders
 * "12GB GDDR6") all ship GDDR6. Matched as a WORD-BOUNDARY token of the
 * device name (the tokensOf regex - a '5775C'-style exact token, never a
 * substring: '15775C' can never match '5775C'). Anything else (iGPUs,
 * non-Intel GPUs) -> null -> the type is OMITTED (never a wrong claim).
 */
export const INTEL_GDDR6_TOKENS = Object.freeze([
  'a310', 'a350', 'a370', 'a380', 'a580', 'a750', 'a770',
  'b50', 'b570', 'b580', 'b60',
]);

/**
 * M4-I: derive the memory type from a device NAME (word-boundary token
 * against the known-Intel table). Null when unknown - the renderer's VRAM
 * row then shows the size only ("VRAM 8GB").
 * @param {string | null | undefined} name
 * @returns {string | null}
 */
export function vramMemTypeOfName(name) {
  const tokens = new Set(String(name ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []);
  for (const token of INTEL_GDDR6_TOKENS) {
    if (tokens.has(token)) return 'GDDR6';
  }
  return null;
}

/**
 * M4-B/M4-I: format a GPU display name with its VRAM amount + type
 * ("Intel Arc A770 16GB GDDR6"), formatted ONCE at listDevices time by the
 * backends (never per render - every consumer reads device.name). Rules:
 *   - vramBytes null / 0 / missing -> the plain name (no suffix);
 *   - >= 1 GiB -> "XGB" - CEIL to the next whole GiB (M4-I S1: the user's
 *     "round to the next number" - 8 GiB -> 8GB, 16 GiB -> 16GB, 2.4 GiB ->
 *     3GB; the M4-B nearest-GiB rounding is REPLACED);
 *   - < 1 GiB -> "X MB" (rounded down to whole MiB - the sub-GiB branch
 *     stays floor-MiB, fold r2.8);
 *   - memType: the explicit `memType` argument wins when supplied (the mock
 *     passes the fixture's value); otherwise derived INTERNALLY from the
 *     name's word-boundary token table (the igcl call site needs no new
 *     plumbing); unknown -> the type is omitted ("Name 8GB").
 * @param {string} name
 * @param {number|null|undefined} vramBytes
 * @param {string|null|undefined} [memType]
 * @returns {string}
 */
export function formatDeviceName(name, vramBytes, memType) {
  if (!name || !Number.isInteger(vramBytes) || vramBytes <= 0) return name;
  const type = typeof memType === 'string' && memType.length > 0 ? memType : vramMemTypeOfName(name);
  const suffix = type ? ` ${type}` : '';
  // M4-I (S1): the GB branch moves to CEIL (the user's "round to the next
  // number" - no two-numbers-on-one-screen: 8 GiB -> "8GB", 16 GiB ->
  // "16GB"); the sub-GiB branch stays whole-MiB floor (a 512 MiB card never
  // rounds to "1GB" - the >= 1 GiB gate keeps the ceil from ever touching
  // the MiB branch).
  if (vramBytes >= 1024 * 1024 * 1024) {
    const gib = Math.ceil(vramBytes / (1024 * 1024 * 1024));
    return `${name} ${gib}GB${suffix}`;
  }
  const mib = Math.floor(vramBytes / (1024 * 1024));
  return `${name} ${mib} MB`;
}
