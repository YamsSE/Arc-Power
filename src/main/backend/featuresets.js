// Arc Power - M2D mock featureset loader + validator.
//
// The mock distribution file: one JSON per device line (b580 today; a770 /
// pro-b50 / arc-igpu when shipped), the single source of truth for
// MockBackend caps, ranges, supported controls, fan config and telemetry
// behavior. Env knob: RID_MOCK_FEATURESET=<id> selects the file (default
// b580 - the only shipped line; a missing or invalid file degrades to the
// first loadable fixture, or to the explicit no-device state when the
// directory ships nothing usable, and always returns a warning that names
// the missing id). Mock mode must never crash on a bad env value or an
// incomplete fixture drop. Electron-free so the whole parser is
// unit-testable under plain `node --test`.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// src/main/backend -> repo root (dev); app.asar/src/main/backend in the
// packaged app (mock/ is optional there - a missing dir degrades to the
// a770 default with a warning, never a crash).
const packagedTestFixtures = typeof process.resourcesPath === 'string'
  ? path.join(process.resourcesPath, 'mock', 'featuresets') : null;
export const FEATURESETS_DIR = process.argv.includes('--mock') && packagedTestFixtures && existsSync(packagedTestFixtures)
  ? packagedTestFixtures : path.resolve(__dirname, '..', '..', '..', 'mock', 'featuresets');
/**
 * The id requested when RID_MOCK_FEATURESET is unset. It must name a line the
 * distribution actually ships: b580 is the only shipped fixture (see
 * `mock/featuresets/`), so a missing default here is what used to kill every
 * bare mock run. Keep this honest when fixtures are added/removed.
 */
export const DEFAULT_FEATURESET_ID = 'b580';
/** Id of the explicit no-device state (no loadable fixture on disk). */
export const NO_DEVICE_FEATURESET_ID = '__no-device__';

/** Canonical scalar-control key for a control name (CONTROLS minus gpuLock/vfCurve/fan). */
export const CONTROL_TO_CANONICAL = Object.freeze({
  gpuFreqOffset: 'gpuFreqOffsetMhz',
  gpuVoltOffset: 'gpuVoltOffsetV',
  powerLimit: 'powerLimitW',
  tempLimit: 'tempLimitC',
  vramFreqOffset: 'vramFreqOffsetGts',
  vramVoltOffset: 'vramVoltOffsetV',
});

/** Control names that need no capability range (non-scalar). */
const RANGELESS_CONTROLS = new Set(['gpuLock', 'vfCurve']);

/** Canonical range key -> control name (inverse of CONTROL_TO_CANONICAL). */
const CANONICAL_TO_CONTROL = Object.freeze(
  Object.fromEntries(Object.entries(CONTROL_TO_CANONICAL).map(([c, k]) => [k, c])),
);

const ALL_CONTROLS = new Set([...Object.keys(CONTROL_TO_CANONICAL), ...RANGELESS_CONTROLS]);

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Structural validation of one featureset object. Throws Error with a clear
 * message on anything malformed; returns the object unchanged when legal.
 * @param {unknown} raw
 * @param {string} [expectedId] the file id the object must match (when loaded from disk)
 * @returns {object}
 */
export function validateFeatureset(raw, expectedId) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('featureset must be a JSON object');
  }
  const fs = raw;
  if (expectedId !== undefined && fs.id !== expectedId) {
    throw new Error(`featureset id '${fs.id}' does not match the file '${expectedId}'`);
  }
  if (!isNonEmptyString(fs.id)) throw new Error('featureset id must be a non-empty string');
  if (!isNonEmptyString(fs.name)) throw new Error(`featureset '${fs.id}': name must be a non-empty string`);
  if (!isNonEmptyString(fs.deviceName)) throw new Error(`featureset '${fs.id}': deviceName must be a non-empty string`);
  if (!isNonEmptyString(fs.driverVersion)) throw new Error(`featureset '${fs.id}': driverVersion must be a non-empty string`);
  // M2D: the display-driver registry date ("7-5-2026") is optional - null or
  // absent when unverified (estimated featuresets), the swap payload then
  // nulls the card date instead of pairing a stale boot date.
  if (fs.driverDate !== undefined && fs.driverDate !== null && !isNonEmptyString(fs.driverDate)) {
    throw new Error(`featureset '${fs.id}': driverDate must be a non-empty string or null`);
  }
  if (!Number.isInteger(fs.numXeCores) || fs.numXeCores <= 0) {
    throw new Error(`featureset '${fs.id}': numXeCores must be a positive integer`);
  }
  for (const key of ['graphicsClockMHz', 'memClockMHz']) {
    if (!isFiniteNumber(fs[key]) || fs[key] <= 0) {
      throw new Error(`featureset '${fs.id}': ${key} must be a positive number`);
    }
  }
  // M4-B: the VRAM amount in BYTES for the display-name suffix ("Arc A770
  // 16 GB"). Optional (null when absent) - integrated GPUs have no VRAM.
  if (fs.vramBytes !== undefined && fs.vramBytes !== null
    && (!Number.isInteger(fs.vramBytes) || fs.vramBytes <= 0)) {
    throw new Error(`featureset '${fs.id}': vramBytes must be a positive integer (bytes) or null`);
  }
  if (typeof fs.hasFan !== 'boolean') throw new Error(`featureset '${fs.id}': hasFan must be a boolean`);
  if (typeof fs.fanCanControl !== 'boolean') throw new Error(`featureset '${fs.id}': fanCanControl must be a boolean`);
  if (!Number.isInteger(fs.fanMaxCurvePoints) || fs.fanMaxCurvePoints < 0) {
    throw new Error(`featureset '${fs.id}': fanMaxCurvePoints must be a non-negative integer`);
  }
  if (fs.hasFan && fs.fanMaxCurvePoints <= 0) {
    throw new Error(`featureset '${fs.id}': fanMaxCurvePoints must be > 0 when hasFan is true`);
  }
  if (!fs.hasFan && fs.fanCanControl) {
    throw new Error(`featureset '${fs.id}': fanCanControl must be false when hasFan is false`);
  }
  if (typeof fs.extendedRanges !== 'boolean') {
    throw new Error(`featureset '${fs.id}': extendedRanges must be a boolean`);
  }
  if (fs.extendedRanges) {
    const ext = fs.extended;
    if (!ext || !isFiniteNumber(ext.plMax) || ext.plMax <= 0 || !isFiniteNumber(ext.tlMax) || ext.tlMax <= 0) {
      throw new Error(`featureset '${fs.id}': extended {plMax, tlMax} positive numbers required when extendedRanges is true`);
    }
  }

  if (fs.vfCurveRange !== undefined && fs.vfCurveRange !== null) {
    const vr = fs.vfCurveRange;
    if (typeof vr !== 'object' || vr === null || Array.isArray(vr)
      || !isFiniteNumber(vr.voltageMinV) || !isFiniteNumber(vr.voltageMaxV)
      || !isFiniteNumber(vr.freqMinMhz) || !isFiniteNumber(vr.freqMaxMhz)
      || !Number.isInteger(vr.maxPoints) || vr.maxPoints < 2
      || vr.voltageMinV >= vr.voltageMaxV || vr.freqMinMhz >= vr.freqMaxMhz) {
      throw new Error(`featureset '${fs.id}': vfCurveRange is invalid`);
    }
  }
  if (fs.vfCurve !== undefined && fs.vfCurve !== null) {
    if (!Array.isArray(fs.vfCurve) || fs.vfCurve.length < 2
      || fs.vfCurve.length > (fs.vfCurveRange?.maxPoints ?? 32)
      || !fs.vfCurve.every((p) => p && isFiniteNumber(p.voltageV) && isFiniteNumber(p.freqMhz))) {
      throw new Error(`featureset '${fs.id}': vfCurve is invalid`);
    }
  }

  // ranges: canonical-keyed, each {units, min, max, step, default} legal.
  if (typeof fs.ranges !== 'object' || fs.ranges === null || Array.isArray(fs.ranges)) {
    throw new Error(`featureset '${fs.id}': ranges must be an object`);
  }
  for (const [canonical, range] of Object.entries(fs.ranges)) {
    const r = range;
    if (typeof r !== 'object' || r === null) {
      throw new Error(`featureset '${fs.id}': range '${canonical}' must be an object`);
    }
    if (!(canonical in CANONICAL_TO_CONTROL)) {
      throw new Error(`featureset '${fs.id}': unknown range key '${canonical}'`);
    }
    for (const field of ['units', 'min', 'max', 'step', 'default']) {
      if (field === 'units' ? !isNonEmptyString(r[field]) : !isFiniteNumber(r[field])) {
        throw new Error(`featureset '${fs.id}': range '${canonical}' has an invalid '${field}'`);
      }
    }
    if (r.min > r.max || r.step <= 0 || r.default < r.min || r.default > r.max) {
      throw new Error(`featureset '${fs.id}': range '${canonical}' must satisfy min<=default<=max and step>0`);
    }
  }

  // supportedControls: subset of the known control names; every scalar
  // control must have its range and every range must back a supported control.
  if (!Array.isArray(fs.supportedControls)) {
    throw new Error(`featureset '${fs.id}': supportedControls must be an array`);
  }
  const controls = new Set(fs.supportedControls);
  for (const c of controls) {
    if (!ALL_CONTROLS.has(c)) throw new Error(`featureset '${fs.id}': unknown control '${c}'`);
  }
  for (const [canonical] of Object.entries(fs.ranges)) {
    if (!controls.has(CANONICAL_TO_CONTROL[canonical])) {
      throw new Error(`featureset '${fs.id}': range '${canonical}' is present but its control is not in supportedControls`);
    }
  }
  for (const [control, canonical] of Object.entries(CONTROL_TO_CANONICAL)) {
    const hasRange = canonical in fs.ranges;
    if (controls.has(control) !== hasRange) {
      throw new Error(`featureset '${fs.id}': control '${control}' must be in supportedControls exactly when its range '${canonical}' exists`);
    }
  }

  // telemetry: numbers + a fanRpm array (or null when no fan).
  const tel = fs.telemetry;
  if (typeof tel !== 'object' || tel === null || Array.isArray(tel)) {
    throw new Error(`featureset '${fs.id}': telemetry must be an object`);
  }
  for (const key of ['gpuClockBaseMhz', 'memClockMhz', 'tempCBase', 'powerW']) {
    if (!isFiniteNumber(tel[key])) {
      throw new Error(`featureset '${fs.id}': telemetry.${key} must be a number`);
    }
  }
  const fanRpmOk = tel.fanRpm === null || (Array.isArray(tel.fanRpm) && tel.fanRpm.every(isFiniteNumber));
  if (!fanRpmOk) throw new Error(`featureset '${fs.id}': telemetry.fanRpm must be a number array or null`);
  if (fs.hasFan && tel.fanRpm === null) {
    throw new Error(`featureset '${fs.id}': telemetry.fanRpm must be an array when hasFan is true`);
  }

  // M17c: the IGCL subsystem fields (the AIB decode source - the struct
  // fields are uint16s). Optional - null/absent = the honest unknown (the
  // caps aibVendor/aibModel then decode to null).
  for (const key of ['pciSubsysVendorId', 'pciSubsysId']) {
    const v = fs[key];
    if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 0 || v > 0xffff)) {
      throw new Error(`featureset '${fs.id}': ${key} must be a non-negative 16-bit integer or null`);
    }
  }

  // M17e: the per-GPU gpuLock bounds fallback row (the caps.lockRange
  // shape - CANONICAL units, never the raw props values). Optional: absent
  // on devices with no gpuLock control (b580/arc-igpu/pro-b50) and on any
  // card whose range is unknown (the renderer's pure lock-ranges table +
  // the documented fallback cover those). When present, all four bounds
  // must be finite + the min/max pairs consistent.
  if (fs.lockRange !== undefined && fs.lockRange !== null) {
    const lr = fs.lockRange;
    if (typeof lr !== 'object' || lr === null || Array.isArray(lr)) {
      throw new Error(`featureset '${fs.id}': lockRange must be an object or null`);
    }
    for (const field of ['voltMin', 'voltMax', 'freqMin', 'freqMax']) {
      if (!isFiniteNumber(lr[field])) {
        throw new Error(`featureset '${fs.id}': lockRange.${field} must be a finite number`);
      }
    }
    if (lr.voltMin > lr.voltMax || lr.freqMin > lr.freqMax) {
      throw new Error(`featureset '${fs.id}': lockRange must satisfy voltMin<=voltMax and freqMin<=freqMax`);
    }
  }
  return fs;
}

/**
 * The explicit no-device state: what a mock run renders when the featureset
 * directory ships no loadable fixture at all. It is a VALID featureset shape
 * (no controls, no fan, no adapter) so MockBackend can boot its whole surface
 * without inventing a card; consumers then enumerate no device.
 * @returns {object} a fresh clone (callers never share this object)
 */
export function noDeviceFeatureset() {
  return {
    id: NO_DEVICE_FEATURESET_ID,
    name: 'No mock device',
    tag: 'no featureset fixture',
    deviceName: 'No mock device (featureset missing)',
    driverVersion: '0.0.0.0',
    driverDate: null,
    numXeCores: 1,
    graphicsClockMHz: 1,
    memClockMHz: 1,
    vramBytes: null,
    hasFan: false,
    fanCanControl: false,
    fanMaxCurvePoints: 0,
    extendedRanges: false,
    ranges: {},
    supportedControls: [],
    telemetry: { gpuClockBaseMhz: 0, memClockMhz: 0, tempCBase: 0, powerW: 0, fanRpm: null },
    // The machine-readable marker MockBackend keys the no-device session on.
    noDevice: true,
  };
}

/**
 * Read + validate one featureset file without logging. The single place that
 * knows why a load failed, so the caller can put the reason in its warning.
 * @param {string} id
 * @param {string} dir
 * @returns {{ featureset: object } | { error: string }}
 */
function describeFeatureset(id, dir) {
  if (typeof id !== 'string' || id.length === 0) {
    return { error: `invalid featureset id ${JSON.stringify(id)}` };
  }
  const file = path.join(dir, `${id}.json`);
  if (!existsSync(file)) return { error: `not found (${file})` };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return { featureset: validateFeatureset(raw, id) };
  } catch (err) {
    return { error: `failed to load (${err.message})` };
  }
}

/**
 * Load + validate one featureset by id (file must be `<id>.json`). Returns
 * null with a clear console error when the file is missing or malformed -
 * callers fall back (see loadFeaturesetOrFallback).
 * @param {string} id
 * @param {string} [dir] featureset directory (defaults to the distribution dir)
 * @returns {object|null}
 */
export function loadFeatureset(id, dir = FEATURESETS_DIR) {
  const { featureset, error } = describeFeatureset(id, dir);
  if (featureset) return featureset;
  console.error(`[featuresets] featureset '${id}' ${error}`);
  return null;
}

/**
 * Enumerate the distribution files (id + display name + tag) plus the
 * diagnostics for files that were skipped because they failed to load.
 * @param {{ dir?: string }} [options]
 * @returns {{ featuresets: Array<{ id: string, name: string, tag: string }>, warnings: string[] }}
 */
export function listFeaturesets({ dir = FEATURESETS_DIR } = {}) {
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    // A missing/unreadable distribution directory is the empty list, never a
    // crash: `loadFeaturesetOrFallback` turns that into the no-device state.
    return { featuresets: [], warnings: [] };
  }
  const featuresets = [];
  const warnings = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const id = file.replace(/\.json$/, '');
    const { featureset, error } = describeFeatureset(id, dir);
    if (featureset) {
      featuresets.push({ id, name: featureset.name, tag: featureset.tag ?? '' });
    } else {
      // Same behaviour as before (the file is omitted from the list) - it is
      // now also named in the diagnostics instead of disappearing silently.
      console.error(`[featuresets] featureset '${id}' ${error}`);
      warnings.push(`skipped '${file}' (${error})`);
    }
  }
  featuresets.sort((a, b) => a.id.localeCompare(b.id));
  return { featuresets, warnings };
}

/**
 * Resolve a featureset id (defaults to RID_MOCK_FEATURESET, then the shipped
 * DEFAULT_FEATURESET_ID). A missing/invalid id degrades - it never throws and
 * never exits the process:
 *
 *   1. the first loadable fixture in the directory, else
 *   2. the explicit no-device state (see noDeviceFeatureset).
 *
 * Both degraded outcomes carry a warning that names the requested id and any
 * skipped files, so a substitute card is never silent.
 * @param {string} [id]
 * @param {{ dir?: string }} [options]
 * @returns {{ featureset: object, warning: string|null }}
 */
export function loadFeaturesetOrFallback(id = process.env.RID_MOCK_FEATURESET, { dir = FEATURESETS_DIR } = {}) {
  const requested = typeof id === 'string' && id.length > 0 ? id : DEFAULT_FEATURESET_ID;
  const primary = describeFeatureset(requested, dir);
  if (primary.featureset) return { featureset: primary.featureset, warning: null };
  console.error(`[featuresets] featureset '${requested}' ${primary.error}`);
  const { featuresets, warnings } = listFeaturesets({ dir });
  const skipped = warnings.length > 0 ? `; ${warnings.join('; ')}` : '';
  const first = featuresets[0];
  const fallback = first ? describeFeatureset(first.id, dir).featureset : null;
  if (fallback) {
    return {
      featureset: fallback,
      warning: `featureset '${requested}' unavailable (${primary.error}) - using '${fallback.id}'${skipped}`,
    };
  }
  return {
    featureset: noDeviceFeatureset(),
    warning: `featureset '${requested}' unavailable (${primary.error}) and no mock featureset could be loaded from ${dir}${skipped} - running in the explicit no-device state`,
  };
}

/**
 * Enumerate the distribution files (id + display name + tag) for the mock
 * dropdown. Skips files that fail to load (console error + listFeaturesets
 * diagnostics); never throws.
 * @param {string} [dir]
 * @returns {Array<{ id: string, name: string, tag: string }>}
 */
export function listFeaturesetFiles(dir = FEATURESETS_DIR) {
  return listFeaturesets({ dir }).featuresets;
}
