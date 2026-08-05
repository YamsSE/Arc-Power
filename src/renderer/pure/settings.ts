// Arc Power — apply-settings payload validation + building (pure, DOM-free).
//
// Mirrors the main-process contract (src/main/ipc-core.js sanitizeSettings):
// keys must be CONTROLS, scalar values finite numbers, gpuLock a well-formed
// pair, vfCurve/fanCurve well-formed arrays. The main process is the
// authoritative gate; this module keeps the UI honest before it ever sends a
// payload, and builds the payload from slider state.

import type { FanMode, Settings } from '../types.ts';
import { MAX_CURVE_POINTS } from './curve.ts';

const SCALAR_KEYS = new Set([
  'powerLimitW',
  'gpuVoltOffsetV',
  'gpuFreqOffsetMhz',
  'tempLimitC',
  'vramFreqOffsetGts',
  'vramVoltOffsetV',
  'fixedFanPct',
]);

const FAN_MODES = new Set<unknown>(['auto', 'curve', 'fixed']);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPointArray(v: unknown, fields: string[]): boolean {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_CURVE_POINTS) return false;
  return v.every((pt) => typeof pt === 'object' && pt !== null && fields.every((f) => isFiniteNumber((pt as Record<string, unknown>)[f])));
}

/**
 * True when `value` is a legal apply-settings payload: an object whose keys
 * are known controls and whose values are finite numbers / well-formed
 * arrays or objects. Anything else (unknown keys, NaN, garbage) is rejected.
 */
export function validateSettingsPayload(value: unknown): value is Settings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  for (const [key, v] of Object.entries(value)) {
    if (SCALAR_KEYS.has(key)) {
      if (!isFiniteNumber(v)) return false;
    } else if (key === 'fanMode') {
      if (!FAN_MODES.has(v)) return false;
    } else if (key === 'gpuLock') {
      if (typeof v !== 'object' || v === null || !isFiniteNumber((v as { voltageV?: unknown }).voltageV) || !isFiniteNumber((v as { freqMhz?: unknown }).freqMhz)) return false;
    } else if (key === 'vfCurve') {
      if (!isPointArray(v, ['voltageV', 'freqMhz'])) return false;
    } else if (key === 'fanCurve') {
      if (!isPointArray(v, ['t', 'speedPct'])) return false;
    } else {
      return false; // unknown key
    }
  }
  return true;
}

/**
 * Build a Settings payload from per-control slider values (only supported
 * controls are included). Values are assumed pre-snapped.
 */
export function buildScalarSettings(values: Record<string, number>): Settings {
  const out: Settings = {};
  for (const [key, v] of Object.entries(values)) {
    if (SCALAR_KEYS.has(key) && isFiniteNumber(v)) {
      (out as Record<string, number>)[key] = v;
    }
  }
  return out;
}

/** Build a fan Settings payload from editor state. */
export function buildFanSettings(mode: FanMode, curve: Array<{ t: number; speedPct: number }>, fixedPct: number): Settings {
  const out: Settings = { fanMode: mode };
  if (mode === 'curve') out.fanCurve = curve;
  if (mode === 'fixed') out.fixedFanPct = fixedPct;
  return out;
}
