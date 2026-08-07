// Arc Power — M2D mock featureset loader + validator.
//
// The mock distribution file: one JSON per device line (a770 / b580 /
// pro-b50 / arc-igpu), the single source of truth for MockBackend caps,
// ranges, supported controls, fan config and telemetry behavior. Env knob:
// RID_MOCK_FEATURESET=<id> selects the file (default a770; a missing or
// invalid file falls back to a770 with a clear error). Electron-free so
// the whole parser is unit-testable under plain `node --test`.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// src/main/backend -> repo root (dev); app.asar/src/main/backend in the
// packaged app (mock/ is optional there — a missing dir degrades to the
// a770 default with a warning, never a crash).
export const FEATURESETS_DIR = path.resolve(__dirname, '..', '..', '..', 'mock', 'featuresets');
export const DEFAULT_FEATURESET_ID = 'a770';

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
  // M2D: the display-driver registry date ("7-5-2026") is optional — null or
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
  // 16 GB"). Optional (null when absent) — integrated GPUs have no VRAM.
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
  return fs;
}

/**
 * Load + validate one featureset by id (file must be `<id>.json`). Returns
 * null with a clear console error when the file is missing or malformed —
 * callers fall back (see loadFeaturesetOrFallback).
 * @param {string} id
 * @returns {object|null}
 */
export function loadFeatureset(id) {
  if (typeof id !== 'string' || id.length === 0) {
    console.error(`[featuresets] invalid featureset id: ${JSON.stringify(id)}`);
    return null;
  }
  const file = path.join(FEATURESETS_DIR, `${id}.json`);
  if (!existsSync(file)) {
    console.error(`[featuresets] featureset '${id}' not found (${file}) — falling back to '${DEFAULT_FEATURESET_ID}'`);
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return validateFeatureset(raw, id);
  } catch (err) {
    console.error(`[featuresets] featureset '${id}' failed to load: ${err.message}`);
    return null;
  }
}

/**
 * Resolve a featureset id (defaults to RID_MOCK_FEATURESET, then a770).
 * A missing/invalid id degrades to the a770 default with a warning —
 * mock mode must never crash on a bad env value.
 * @param {string} [id]
 * @returns {{ featureset: object, warning: string|null }}
 */
export function loadFeaturesetOrFallback(id = process.env.RID_MOCK_FEATURESET) {
  const requested = typeof id === 'string' && id.length > 0 ? id : DEFAULT_FEATURESET_ID;
  const fs = loadFeatureset(requested);
  if (fs) return { featureset: fs, warning: null };
  const fallback = loadFeatureset(DEFAULT_FEATURESET_ID);
  if (!fallback) {
    throw new Error(`no mock featureset could be loaded (checked ${FEATURESETS_DIR})`);
  }
  return {
    featureset: fallback,
    warning: `featureset '${requested}' unavailable — using '${DEFAULT_FEATURESET_ID}'`,
  };
}

/**
 * Enumerate the distribution files (id + display name + tag) for the mock
 * dropdown. Skips files that fail to load (the console error is already out).
 * @returns {Array<{ id: string, name: string, tag: string }>}
 */
export function listFeaturesetFiles() {
  if (!existsSync(FEATURESETS_DIR)) return [];
  const out = [];
  for (const file of readdirSync(FEATURESETS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const id = file.replace(/\.json$/, '');
    const fs = loadFeatureset(id);
    if (fs) out.push({ id, name: fs.name, tag: fs.tag ?? '' });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
