// Arc Power - IPC handlers factory + payload validation (the security
// surface). Kept electron-free so the whole contract is unit-testable under
// plain `node --test` (no electron import). Registration over ipcMain lives
// in ipc.js.
//
// Contract:
//   - deviceId is a non-negative integer, validated on every handler;
//   - apply-settings payload: plain object, keys ⊆ CONTROLS, values finite
//     numbers / well-formed arrays or objects - anything else is rejected
//     before it can reach the backend;
//   - apply-settings re-clamps scalar values against the device's capability
//     ranges in main (product applies snap to the capability step);
//   - after apply/reset the current settings are always re-read (IGS may
//     have changed OC state between runs) and returned to the caller;
//   - telemetry is owned by main (one TelemetryService per device), pushed
//     to the renderer via the injected `emit`;
//   - the waiver is NEVER auto-accepted for a NEVER-accepted store:
//     waiver-accept is the only path to setWaiverAccepted, and it is called
//     by the renderer only after the user explicitly accepted the dialog.
//     M4-D (PERMANENT acceptance): once the store says accepted (the user
//     accepted once), MAIN silently re-sets the driver waiver + retries the
//     apply ONCE on a waiver-not-set answer - the persisted consent stands,
//     the store is never flipped back to false (persistWaiverLost removed).

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TelemetryService } from './telemetry/telemetry-service.js';
import { collectHealth } from './health.js';
import { CONTROLS, GRAPHICS_FRAME_GEN_OPTIONS, GRAPHICS_FLIP_MODE_OPTIONS, GRAPHICS_LOW_LATENCY_OPTIONS, DISPLAY_QUANTIZATION_OPTIONS, DISPLAY_WIRE_FORMAT_OPTIONS, DISPLAY_BPC_OPTIONS, DISPLAY_SCALING_MODE_OPTIONS, DISPLAY_SCALING_METHOD_OPTIONS, DISPLAY_GLOBAL_VRR_MODE_OPTIONS } from './backend/backend.interface.js';
import { clampAndSnap, clampGpuLock, nearlyEqual, deviceHardwareKey, isIntegratedStyleDevice } from './backend/units.js';
import { pnpParts } from './gpu-inventory.js';
import { REGISTRY_CATALOG, createMockRegistryCatalog, createMockRegistryState } from './registry-catalog.js';
import { createMockRegistryApply } from './registry-apply.js';
import { createMockStartup } from './startup.js';
import { createMockDriverInfo } from './driver-info.js';
import { createMockSysinfo } from './sysinfo.js';
import { createMockSysStats } from './sys-stats.js';
import { executeApply, withCapabilityFlags, createNullOldIgcl, ocModeRefusal, refusalPerControl, extendedUnavailableRefusal, extendedUnavailablePerControl, extendedRangesFor, tempCapabilityRefusal, tempCapabilityPerControl, isSysmanPrimaryPowerRequest, wcUnitControls, EXTENDED_UNAVAILABLE_MSG, OC_MODES, OC_MODE_ADVANCED } from './apply-routing.js';
import { isElevated as detectElevated } from './elevation.js';
import { THEMES, OVERLAY_POSITIONS, OVERLAY_STAT_IDS, OVERLAY_STATS_DEFAULT, OVERLAY_POLL_MS_DEFAULT, normalizeMonitorLogMetrics, activeProfileEntries } from './store/profile-store.js';
// M17c: the vendor-telemetry lane (non-Intel GPU readouts - NVML/ADL via
// koffi, hook = the no-device telemetry path, mock fixtures under
// RID_MOCK_VENDOR).
import { createVendorTelemetry } from './vendor-telemetry/vendor-telemetry.js';
import { physicalTargetOf } from './gpu-inventory.js';
import { GameProfileStore, canonicalExePath, mergeGameGpuProfiles, mergeGameGpuProfilePatch, normalizeAssociation, normalizeGameGpuProfile, normalizeGameSettings } from './store/game-profile-store.js';
import { createGameScanAdapter, normalizeScannedApps } from './game-scan.js';
import { validateSafeGameCandidate } from './game-candidate.js';
import { collisionSafeRecordingPath, normalizeRecordingSettings, recordingAbsolutePath, RECORDING_AUDIO_SOURCE_MODES, RECORDING_CAPTURE_COLOR_MODES, RECORDING_CAPTURE_TARGET_TYPES, RECORDING_FPS_MAX, RECORDING_FPS_MIN, RECORDING_MODES, RECORDING_RESOLUTIONS, safeVideoExtension, validateRecordingProcessNames } from './recording-pure.js';
import { closeSafeRecordingFile, isOpaqueClipId, mediaClipUrl, mediaThumbnailUrl, openSafeRecordingFile, resolveSafeRecordingPath, unlinkSafeRecordingFile } from './recording-media.js';

const require = createRequire(import.meta.url);
// The app version shipped to the renderer for the header line (B3); the
// product path injects app.getVersion() from ipc.js - this is the default
// when no electron app exists (tests).
const PKG_VERSION = require('../../package.json').version ?? '0.0.0';

const RECORDING_PATCH_KEYS = new Set(['location', 'runtimePath', 'mode', 'fps', 'resolution', 'encoderId', 'bitrateKbps', 'captureTarget', 'captureColorMode', 'showCursor', 'replayLengthSec', 'hotkeys', 'audio']);
export { recordingAbsolutePath };

const execFileAsync = promisify(execFile);

function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && line[index + 1] === '"' && quoted) { field += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) { fields.push(field); field = ''; }
    else field += character;
  }
  fields.push(field);
  return fields;
}

export function parseRecordingProcessList(output) {
  const names = String(output ?? '').split(/\r?\n/).map((line) => parseCsvLine(line.trim())[0]?.trim()).filter((name) => name && !/^INFO:/i.test(name));
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** Parse the newline-delimited live-main-window process names from PowerShell. */
export function parseRecordingWindowProcessList(output) {
  const names = String(output ?? '').split(/\r?\n/).map((line) => line.trim()).filter((name) => name && !/^INFO:/i.test(name));
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function recordingStorageSnapshot(location) {
  let candidate = path.resolve(location);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    try {
      const stats = fs.statfsSync(candidate);
      const blockSize = Number(stats.bsize);
      const freeBlocks = Number(stats.bavail);
      const totalBlocks = Number(stats.blocks);
      const toBytes = (blocks) => Number.isFinite(blocks) && Number.isFinite(blockSize) && blockSize > 0
        ? Math.max(0, Math.round(blocks * blockSize))
        : null;
      return { freeBytes: toBytes(freeBlocks), totalBytes: toBytes(totalBlocks) };
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  return { freeBytes: null, totalBytes: null };
}

export async function listWindowsRecordingProcesses({ execFileImpl = execFileAsync, platform = process.platform } = {}) {
  if (platform !== 'win32') return [];
  const script = '$ErrorActionPreference = "SilentlyContinue"; Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) } | ForEach-Object { "$($_.ProcessName).exe" }';
  const result = await execFileImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, maxBuffer: 1024 * 1024 });
  return parseRecordingWindowProcessList(result?.stdout ?? result);
}

function recordingPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('recording-settings-save: patch must be an object');
  for (const key of Object.keys(patch)) if (!RECORDING_PATCH_KEYS.has(key)) throw new Error(`recording-settings-save: unknown field '${key}'`);
  const out = { ...patch };
  if (patch.location !== undefined) out.location = recordingAbsolutePath(patch.location, 'location');
  if (patch.runtimePath !== undefined && patch.runtimePath !== '') out.runtimePath = recordingAbsolutePath(patch.runtimePath, 'runtimePath');
  if (patch.mode !== undefined && !RECORDING_MODES.includes(patch.mode)) throw new Error('recording-settings-save: invalid mode');
  if (patch.fps !== undefined && (!Number.isSafeInteger(patch.fps) || patch.fps < RECORDING_FPS_MIN || patch.fps > RECORDING_FPS_MAX)) throw new Error('recording-settings-save: invalid FPS');
  if (patch.resolution !== undefined && !RECORDING_RESOLUTIONS.some((item) => item.id === patch.resolution)) throw new Error('recording-settings-save: invalid resolution');
  if (patch.encoderId !== undefined && (typeof patch.encoderId !== 'string' || patch.encoderId.length > 128)) throw new Error('recording-settings-save: invalid encoder id');
  if (patch.bitrateKbps !== undefined && (typeof patch.bitrateKbps !== 'number' || !Number.isFinite(patch.bitrateKbps) || patch.bitrateKbps <= 0)) throw new Error('recording-settings-save: bitrate must be a positive number');
  if (patch.captureColorMode !== undefined && !RECORDING_CAPTURE_COLOR_MODES.includes(patch.captureColorMode)) throw new Error('recording-settings-save: invalid capture color mode');
  if (patch.showCursor !== undefined && typeof patch.showCursor !== 'boolean') throw new Error('recording-settings-save: show cursor must be a boolean');
  if (patch.captureTarget !== undefined) {
    const target = patch.captureTarget;
    if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('recording-settings-save: capture target must be an object');
    if (target.type !== undefined && !RECORDING_CAPTURE_TARGET_TYPES.includes(target.type)) throw new Error('recording-settings-save: invalid capture target type');
    if (target.displayId !== undefined && (typeof target.displayId !== 'string' || target.displayId.length > 128)) throw new Error('recording-settings-save: invalid display id');
    if (target.windowHandle !== undefined && (!Number.isSafeInteger(target.windowHandle) || target.windowHandle < 0 || target.windowHandle > 0xffffffff)) throw new Error('recording-settings-save: invalid window handle');
    if (target.processName !== undefined && (typeof target.processName !== 'string' || target.processName.length > 256)) throw new Error('recording-settings-save: invalid process name');
    if (target.windowTitle !== undefined && (typeof target.windowTitle !== 'string' || target.windowTitle.length > 512)) throw new Error('recording-settings-save: invalid window title');
  }
  if (patch.hotkeys !== undefined && (!patch.hotkeys || typeof patch.hotkeys !== 'object' || Array.isArray(patch.hotkeys))) throw new Error('recording-settings-save: hotkeys must be an object');
  if (patch.audio !== undefined) {
    if (!patch.audio || typeof patch.audio !== 'object' || Array.isArray(patch.audio)) throw new Error('recording-settings-save: audio must be an object');
    const audio = patch.audio;
    if (audio.sourceMode !== undefined && !RECORDING_AUDIO_SOURCE_MODES.includes(audio.sourceMode)) throw new Error('recording-settings-save: invalid audio source mode');
    if (audio.customProcesses !== undefined) validateRecordingProcessNames(audio.customProcesses);
    for (const [section, fields] of [['microphone', ['enabled', 'mono']], ['system', ['enabled']]]) {
      if (audio[section] === undefined) continue;
      if (!audio[section] || typeof audio[section] !== 'object' || Array.isArray(audio[section])) throw new Error(`recording-settings-save: ${section} must be an object`);
      for (const field of fields) if (audio[section][field] !== undefined && typeof audio[section][field] !== 'boolean') throw new Error(`recording-settings-save: ${section}.${field} must be boolean`);
      if (audio[section].deviceId !== undefined && (typeof audio[section].deviceId !== 'string' || audio[section].deviceId.length > 512)) throw new Error(`recording-settings-save: ${section}.deviceId is invalid`);
      if (audio[section].volume !== undefined && (typeof audio[section].volume !== 'number' || !Number.isFinite(audio[section].volume) || audio[section].volume < 0 || audio[section].volume > 1)) throw new Error(`recording-settings-save: ${section}.volume is invalid`);
    }
  }
  return out;
}

// M24 (Part B): the pushed post-apply read-back channel vocabulary (ipc-core
// owns the channel names; ipc.js's handler-loop wrap + tray-apply.js both
// send on them - tray-apply re-exports DEVICE_STATE_UPDATED_CHANNEL
// additively so its existing send site keeps working unchanged).
/** The pushed post-apply DEVICE read-back channel (main -> renderer;
 *  { deviceId, state } - the tray-apply + the ipc.js apply/reset wrap). */
export const DEVICE_STATE_UPDATED_CHANNEL = 'device:state-updated';
/** M24 (Part B): the pushed post-apply GRAPHICS read-back channel (main ->
 *  renderer; { deviceId, graphicsState } - the ipc.js graphics:apply wrap). */
export const GRAPHICS_STATE_UPDATED_CHANNEL = 'graphics:state-updated';
/** M99: main-process Ascent state push for the Recording page. */
export const RECORDING_STATE_CHANNEL = 'recording:state';
/** M101: main-process result push for global recording shortcuts. */
export const RECORDING_ACTION_CHANNEL = 'recording:action';
/** M31: explicit panel request and main-owned atomic selection push channels. */
export const DEVICE_SELECTION_REQUEST_CHANNEL = 'device-selection:request';
export const DEVICE_SELECTION_UPDATED_CHANNEL = 'device-selection:updated';

export function pushRecordingState({ getWindow, state, getHotkeyState = () => ({ registered: {}, conflicts: {}, error: null }) }) {
  const win = getWindow?.();
  if (!win || win.isDestroyed?.() || !win.webContents?.send) return false;
  win.webContents.send(RECORDING_STATE_CHANNEL, { ...state, hotkeys: getHotkeyState() });
  return true;
}

export function pushRecordingActionResult({ getWindow, result }) {
  const win = getWindow?.();
  if (!win || win.isDestroyed?.() || !win.webContents?.send) return false;
  win.webContents.send(RECORDING_ACTION_CHANNEL, result);
  return true;
}

const SCALAR_CONTROLS = new Set([
  'powerLimitW', 'gpuVoltOffsetV', 'gpuFreqOffsetMhz', 'tempLimitC',
  'vramFreqOffsetGts', 'vramVoltOffsetV', 'fixedFanPct',
]);
const FAN_MODES = new Set(['auto', 'curve', 'fixed']);
// ctl_fan_speed_table_t.table size - must match pure/curve.ts MAX_CURVE_POINTS.
const MAX_CURVE_POINTS = 32;
// Reset read-back tolerance (canonical units; a reset must land on the
// capability default within this).
const RESET_VERIFY_EPS = 1e-6;
// M5: the overlay scale slider's range (mirrored in pure/overlay.ts).
const OVERLAY_SCALE_MIN = 0.5;
const OVERLAY_SCALE_MAX = 2.0;
// M17e (the user addition - the overlay polling-rate slider): the
// telemetry push cadence range (mirrored in profile-store.js +
// overlay-settings.ts; the telemetry-service default is 400 ms - M17g:
// the stock polling rate FLIPS 500 -> 400).
const OVERLAY_POLL_MS_MIN = 100;
const OVERLAY_POLL_MS_MAX = 2000;
// M8: the frame-limit clamp fallback (30-300-1-60 - the probe-recorded
// driver range; the fallback only applies when the device reports no range,
// so the clamp can never offer an un-appliable value).
const GRAPHICS_FRAME_LIMIT_FALLBACK = { min: 30, max: 300, step: 1, default: 60 };
const GRAPHICS_MEMORY_OVERRIDE_MIN = 13;
const GRAPHICS_MEMORY_OVERRIDE_MAX = 100;

/**
 * M8: validate a graphics-settings payload and return a clean copy - the
 * DEDICATED graphics validator (plan-review S1: the OC sanitizeSettings
 * keeps rejecting graphics keys - 3D features have no OC waiver and no
 * OC-mode gate, so they never ride the OC machinery). Throws on anything
 * illegal (unknown keys, bad options, malformed frameLimit). The frame-limit
 * value is CLAMPED to the driver-reported range (30-300-1-60 fallback) -
 * the FPS clamp: the renderer can never send an un-appliable value.
 * @param {unknown} payload
 * @param {{ min: number, max: number, step: number, default: number } | null} [range]
 * @returns {import('./backend/backend.interface.js').GraphicsSettings}
 */
export function sanitizeGraphicsSettings(payload, range = null) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('graphics-settings payload must be a plain object');
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'enduranceGaming') {
      if (!['off', 'on', 'auto'].includes(value)) throw new Error('enduranceGaming must be one of: off, on, auto');
      out[key] = value;
    } else if (key === 'enduranceGamingMode') {
      if (!['performance', 'balanced', 'battery'].includes(value)) throw new Error('enduranceGamingMode must be one of: performance, balanced, battery');
      out[key] = value;
    } else if (key === 'sharedMemoryOverride') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)
        || typeof value.enabled !== 'boolean'
        || typeof value.percentage !== 'number'
        || !Number.isInteger(value.percentage)
        || value.percentage < GRAPHICS_MEMORY_OVERRIDE_MIN
        || value.percentage > GRAPHICS_MEMORY_OVERRIDE_MAX) {
        throw new Error(`sharedMemoryOverride must be { enabled: boolean, percentage: integer ${GRAPHICS_MEMORY_OVERRIDE_MIN}-${GRAPHICS_MEMORY_OVERRIDE_MAX} }`);
      }
      out[key] = { enabled: value.enabled, percentage: value.percentage };
    } else if (key === 'frameGenOverride') {
      if (!GRAPHICS_FRAME_GEN_OPTIONS.includes(value)) throw new Error(`frameGenOverride must be one of: ${GRAPHICS_FRAME_GEN_OPTIONS.join(', ')}`);
      out[key] = value;
    } else if (key === 'flipMode') {
      if (!GRAPHICS_FLIP_MODE_OPTIONS.includes(value)) throw new Error(`flipMode must be one of: ${GRAPHICS_FLIP_MODE_OPTIONS.join(', ')}`);
      out[key] = value;
    } else if (key === 'lowLatency') {
      if (!GRAPHICS_LOW_LATENCY_OPTIONS.includes(value)) throw new Error(`lowLatency must be one of: ${GRAPHICS_LOW_LATENCY_OPTIONS.join(', ')}`);
      out[key] = value;
    } else if (key === 'prebuiltShaderDownload') {
      if (typeof value !== 'boolean') throw new Error('prebuiltShaderDownload must be enabled or disabled');
      out[key] = value;
    } else if (key === 'frameLimit') {
      if (typeof value !== 'object' || value === null
        || typeof value.enabled !== 'boolean'
        || typeof value.value !== 'number' || !Number.isFinite(value.value)) {
        throw new Error('frameLimit must be { enabled: boolean, value: number }');
      }
      const r = range && Number.isFinite(range.min) && Number.isFinite(range.max) && range.max > range.min
        ? range
        : GRAPHICS_FRAME_LIMIT_FALLBACK;
      const snapped = r.step > 0 ? Math.round(value.value / r.step) * r.step : value.value;
      out[key] = { enabled: value.enabled, value: Math.min(r.max, Math.max(r.min, snapped)) };
    } else {
      throw new Error(`unknown graphics setting: ${key}`);
    }
  }
  return out;
}

/**
 * M10b: validate a display-settings payload and return a clean copy - the
 * DEDICATED display validator (plan-review S1, the graphics twin: the OC
 * sanitizeSettings keeps rejecting display keys - display settings have no
 * OC waiver and no OC-mode gate, so they never ride the OC machinery).
 * Throws on anything illegal (unknown keys, bad options, a malformed
 * wireFormat pair). The wire-format depth is validated against the
 * canonical BPC list (6/8/10/12 - the driver's bpc-flag bit values). The
 * per-display supported-list gating stays in the backend (the M10b-fix
 * lesson: no caps pre-gate - the driver's ACTUAL answer decides).
 * @param {unknown} payload
 * @returns {import('./backend/backend.interface.js').DisplaySettings}
 */
export function sanitizeDisplaySettings(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('display-settings payload must be a plain object');
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'quantizationRange') {
      if (!DISPLAY_QUANTIZATION_OPTIONS.includes(value)) throw new Error(`quantizationRange must be one of: ${DISPLAY_QUANTIZATION_OPTIONS.join(', ')}`);
      out[key] = value;
    } else if (key === 'wireFormat') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)
        || !DISPLAY_WIRE_FORMAT_OPTIONS.includes(value.model)
        || !DISPLAY_BPC_OPTIONS.includes(value.depth)) {
        throw new Error(`wireFormat must be { model: one of ${DISPLAY_WIRE_FORMAT_OPTIONS.join(', ')}, depth: one of ${DISPLAY_BPC_OPTIONS.join(', ')} }`);
      }
      out[key] = { model: value.model, depth: value.depth };
    } else if (key === 'scalingMode') {
      if (!DISPLAY_SCALING_MODE_OPTIONS.includes(value)) throw new Error(`scalingMode must be one of: ${DISPLAY_SCALING_MODE_OPTIONS.join(', ')}`);
      out[key] = value;
    } else if (key === 'displayScalingMethod') {
      if (!DISPLAY_SCALING_METHOD_OPTIONS.includes(value)) throw new Error(`displayScalingMethod must be one of: ${DISPLAY_SCALING_METHOD_OPTIONS.join(', ')}`);
      out[key] = value;
    } else if (key === 'scalingCustom') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)
        || typeof value.x !== 'number' || !Number.isFinite(value.x) || value.x < 0 || value.x > 100
        || typeof value.y !== 'number' || !Number.isFinite(value.y) || value.y < 0 || value.y > 100
        || (value.hardwareModeSet !== undefined && typeof value.hardwareModeSet !== 'boolean')) {
        throw new Error('scalingCustom must be { x: 0..100, y: 0..100, hardwareModeSet?: boolean }');
      }
      out[key] = { x: value.x, y: value.y, ...(value.hardwareModeSet === undefined ? {} : { hardwareModeSet: value.hardwareModeSet }) };
    } else if (key === 'scalingMethod') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)
        || typeof value.enabled !== 'boolean'
        || !['integer', 'nearest-neighbour'].includes(value.method)) {
        throw new Error('scalingMethod must be { enabled: boolean, method: integer|nearest-neighbour }');
      }
      out[key] = { enabled: value.enabled, method: value.method };
    } else if (key === 'vrrMode') {
      if (!['recommended', 'excellent', 'good', 'compatible', 'off', 'vesa', 'custom'].includes(value)) {
        throw new Error('vrrMode must be one of: recommended, excellent, good, compatible, off, vesa, custom');
      }
      out[key] = value;
    } else if (key === 'globalVrrMode') {
      if (!DISPLAY_GLOBAL_VRR_MODE_OPTIONS.includes(value)) throw new Error(`globalVrrMode must be one of: ${DISPLAY_GLOBAL_VRR_MODE_OPTIONS.join(', ')}`);
      out[key] = value;
    } else if (key === 'variableRefreshRate') {
      if (typeof value !== 'boolean') throw new Error('variableRefreshRate must be enabled or disabled');
      out[key] = value;
    } else if (['hue', 'saturation', 'brightness', 'contrast'].includes(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
      out[key] = value;
    } else {
      throw new Error(`unknown display setting: ${key}`);
    }
  }
  return out;
}

/**
 * M5: the hotkey letter must be EXACTLY one letter (CTRL + <letter> - the
 * rule: the letter is the only changeable part). Rejects with an
 * honest error - a multi-char or non-letter hotkey must never reach the
 * registration.
 * @param {unknown} v
 * @returns {string}
 */
export function validateOverlayHotkeyLetter(v) {
  if (typeof v !== 'string' || !/^[A-Za-z]$/.test(v)) {
    throw new Error('overlayHotkeyLetter must be a single letter (A-Z or a-z)');
  }
  // Normalize to UPPERCASE at persist time - every consumer (the
  // globalShortcut accelerator, the Settings card text) uses the uppercase
  // form; a stored lowercase letter must never slip through.
  return v.toUpperCase();
}

/**
 * M5: the overlay corner must be one of the four positions (reject +
 * honest error - a garbage position must never reach the geometry code).
 * @param {unknown} v
 * @returns {string}
 */
export function validateOverlayPosition(v) {
  if (typeof v !== 'string' || !OVERLAY_POSITIONS.includes(v)) {
    throw new Error(`overlayPosition must be one of: ${OVERLAY_POSITIONS.join(', ')}`);
  }
  return v;
}

/**
 * M23: the ADVANCED overlay's anchored edge must be 'left' | 'right' (reject
 * + honest error - a garbage position must never reach the geometry code;
 * the renderer mirror is pure/overlay.ts, the store normalize is
 * profile-store.js - keep the three in lockstep).
 * @param {unknown} v
 * @returns {'left'|'right'}
 */
export function validateAdvancedOverlayPosition(v) {
  if (typeof v !== 'string' || (v !== 'left' && v !== 'right')) {
    throw new Error('advancedOverlayPosition must be one of: left, right');
  }
  return v;
}

/**
 * M5: clamp the overlay scale to the slider's range 0.5..2.0 (garbage
 * degrades to the 1.0 default - the store normalizes the same way).
 * @param {unknown} v
 * @returns {number}
 */
export function clampOverlayScale(v) {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 1.0;
  return Math.min(OVERLAY_SCALE_MAX, Math.max(OVERLAY_SCALE_MIN, n));
}

/**
 * M6: the overlay text color must be a 6-digit hex string (the
 * type=color input + the swatch presets always yield this shape; the
 * stock default is '#ffffff'). REJECTS with an honest error - a garbage
 * color must never reach the overlay renderer.
 * @param {unknown} v
 * @returns {string}
 */
export function validateOverlayColor(v) {
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) {
    throw new Error('overlayColor must be a hex color like #ffffff');
  }
  return v;
}

/**
 * M7b: the overlay background box color must be a 6-digit hex string (the
 * same shape as overlayColor - the swatch presets + the type=color input;
 * the stock default is '#000000'). REJECTS with an honest error - a
 * garbage color must never reach the overlay renderer.
 * @param {unknown} v
 * @returns {string}
 */
export function validateOverlayBgColor(v) {
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) {
    throw new Error('overlayBgColor must be a hex color like #000000');
  }
  return v;
}

/**
 * M24: the overlay THEME must be 'classic' | 'arc' (the validateOverlayColor
 * pattern - the Theme row's two buttons can only produce the two ids; a
 * garbage patch must never reach the overlay renderer). The persisted-name
 * 'overlayTheme' rides the settings patch; the pushed overlay payload
 * shortens to 'theme'.
 * @param {unknown} v
 * @returns {'classic'|'arc'}
 */
export function validateOverlayTheme(v) {
  if (typeof v !== 'string' || (v !== 'classic' && v !== 'arc')) {
    throw new Error('overlayTheme must be one of: classic, arc');
  }
  return v;
}

/**
 * M7b: clamp the background box opacity to 0..1 (garbage degrades to the
 * 0.5 default - the same clamp semantics as the overlay scale; the slider
 * cannot produce an out-of-range value).
 * @param {unknown} v
 * @returns {number}
 */
export function clampOverlayBgOpacity(v) {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0.5;
  return Math.min(1, Math.max(0, n));
}

/**
 * M17e (the user addition - the overlay polling-rate slider): clamp the
 * telemetry push cadence to the slider's 100-2000 ms range (garbage
 * degrades to the 400 ms default - M17g: the stock polling rate FLIPS 500
 * -> 400; the telemetry-service default; the
 * same clamp semantics as the scale; the slider cannot produce an
 * out-of-range value).
 * @param {unknown} v
 * @returns {number}
 */
export function clampOverlayPollMs(v) {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : OVERLAY_POLL_MS_DEFAULT;
  return Math.min(OVERLAY_POLL_MS_MAX, Math.max(OVERLAY_POLL_MS_MIN, Math.round(n)));
}
/**
 * M35: normalize the persisted overlay GPU selection. Device keys are
 * durable PCI/BDF identities, never enumeration indexes. A missing or empty
 * list means the backward-compatible all-GPU default.
 * @param {unknown} v
 * @returns {string[]|null}
 */
export function normalizeOverlayDeviceKeys(v) {
  if (!Array.isArray(v)) return null;
  const seen = new Set();
  const out = [];
  for (const key of v) {
    if (typeof key === 'string' && key.length > 0 && key.length <= 256 && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out.length > 0 ? out : null;
}


/**
 * M6: normalize a raw overlayStats patch value - an array of KNOWN stat
 * ids, deduped (order preserved); unknown ids are DROPPED, absent/garbage
 * degrades to the DEFAULT set (M17g: the user's 11 ON / the others OFF -
 * the M6 full-set default FLIPS; the same default the store carries).
 * Never rejects - the
 * tickboxes can only produce known ids, and a partial garbage value must
 * not fail the whole save.
 * M16 (B1): the SAVE-path normalize is deliberately FILTER-ONLY - the
 * one-time upgrade of PERSISTED pre-M16 lists (gaining 'gpu-voltage' +
 * 'gpu-vram-temp') runs in the store's v2 -> v3 schema migration. A union
 * here would re-add a stat the user just unchecked on the very save that
 * was supposed to persist the uncheck.
 * @param {unknown} v
 * @returns {string[]}
 */
export function normalizeOverlayStats(v) {
  if (!Array.isArray(v)) return [...OVERLAY_STATS_DEFAULT];
  const seen = new Set();
  const out = [];
  for (const id of v) {
    if (typeof id === 'string' && OVERLAY_STAT_IDS.includes(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * @param {unknown} v
 * @returns {number}
 */
export function assertValidDeviceId(v) {
  if (!Number.isInteger(v) || v < 0) {
    throw new Error(`invalid device id: ${JSON.stringify(v)}`);
  }
  return v;
}

/**
 * Validate an apply-settings payload and return a clean copy. Throws on
 * anything that is not a legal Settings object (unknown keys, NaN,
 * malformed arrays/objects).
 * @param {unknown} payload
 * @returns {import('./backend/backend.interface.js').Settings}
 */
export function sanitizeSettings(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('apply-settings payload must be a plain object');
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!CONTROLS.includes(key)) throw new Error(`unknown control: ${key}`);
    if (SCALAR_CONTROLS.has(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${key} must be a finite number`);
      }
      out[key] = value;
    } else if (key === 'fanMode') {
      if (!FAN_MODES.has(value)) throw new Error(`fanMode must be one of: auto, curve, fixed`);
      out[key] = value;
    } else if (key === 'gpuLock') {
      if (typeof value !== 'object' || value === null
        || !Number.isFinite(value.voltageV) || !Number.isFinite(value.freqMhz)) {
        throw new Error('gpuLock must be { voltageV: number, freqMhz: number }');
      }
      out[key] = { voltageV: value.voltageV, freqMhz: value.freqMhz };
    } else if (key === 'vfCurve' || key === 'fanCurve') {
      if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CURVE_POINTS) {
        throw new Error(`${key} must be a non-empty array of at most ${MAX_CURVE_POINTS} points`);
      }
      const fields = key === 'vfCurve' ? ['voltageV', 'freqMhz'] : ['t', 'speedPct'];
      out[key] = value.map((pt) => {
        if (typeof pt !== 'object' || pt === null || fields.some((f) => !Number.isFinite(pt[f]))) {
          throw new Error(`${key} points must be objects with finite ${fields.join(', ')}`);
        }
        /** @type {Record<string, number>} */
        const clean = {};
        for (const f of fields) clean[f] = pt[f];
        return clean;
      });
    }
  }
  return out;
}

/**
 * Re-clamp scalar settings against the device capability ranges (snap to
 * the capability step). Non-scalar controls pass through - the backend
 * gates them itself; gpuLock is clamped to the documented lock bounds
 * (clampGpuLock) so an extreme pair never reaches the driver.
 * @param {import('./backend/backend.interface.js').Settings} settings
 * @param {Record<string, { min: number, max: number, step: number, default: number, units: string }>} ranges
 * @returns {import('./backend/backend.interface.js').Settings}
 */
export function clampSettings(settings, ranges) {
  const out = { ...settings };
  for (const key of Object.keys(out)) {
    const range = ranges[key];
    if (range && SCALAR_CONTROLS.has(key) && typeof out[key] === 'number') {
      out[key] = clampAndSnap(out[key], range);
    }
  }
  if (out.gpuLock) out.gpuLock = clampGpuLock(out.gpuLock);
  return out;
}

/**
 * Boot-time waiver seeding (F1): restore a persisted acceptance (settings.json
 * written by waiver-accept) into the backend's IN-MEMORY flag WITHOUT calling
 * the driver - ctlOverclockWaiverSet must only run on explicit user
 * acceptance, so this never implicitly accepts. A store read failure degrades
 * to not-accepted (the waiver dialog re-shows on the next apply - safe).
 * Call once after backend.init() before the renderer boots.
 * @param {import('./backend/backend.interface.js').IOCBackend} backend
 * @param {import('./store/profile-store.js').ProfileStore} store
 */
export async function seedWaiverState(backend, store) {
  const devices = await backend.listDevices();
  let accepted = false;
  try {
    accepted = (await store.loadSettings()).waiverAccepted === true;
  } catch {
    // degraded: treat as not accepted - never a false "accepted"
  }
  for (const device of devices) {
    await backend.restoreWaiverState(device.id, accepted);
  }
}

/**
 * M17d (Run E): the once-per-driver-version gate for probeWaiverState. The
 * elevated boot probe is a driver round trip (caps + settings + a
 * value-neutral PL write) that exists to catch a waiver the DRIVER lost
 * (reinstall / IGS reset - both tied to the driver version). After the
 * FIRST boot on a given driver version the probe has verified the store -
 * re-running it on every boot is redundant. The gate: the persisted
 * `waiverProbedDriverVersion` (settings.json) vs the CURRENT driver version
 * (backend.health - the IGCL raw version, stable per driver, changes on a
 * driver update). A mismatch (absent / unknown / changed) means the probe is
 * DUE; an unknown current version never skips (the safe side - an
 * unverifiable state re-probes).
 * @param {import('./backend/backend.interface.js').IOCBackend} backend
 * @param {import('./store/profile-store.js').ProfileStore} store
 * @returns {Promise<{ due: boolean, key: string | null }>}
 */
export async function waiverProbeDue(backend, store) {
  let current = null;
  try {
    const h = await backend.health();
    current = h && typeof h.driverVersion === 'string' && h.driverVersion ? h.driverVersion : null;
  } catch {
    current = null;
  }
  if (current === null) {
    // the driver version is unreadable - never skip the probe on an unknown
    return { due: true, key: null };
  }
  let persisted = null;
  try {
    const s = await store.loadSettings();
    persisted = typeof s.waiverProbedDriverVersion === 'string' ? s.waiverProbedDriverVersion : null;
  } catch {
    persisted = null;
  }
  return { due: persisted !== current, key: current };
}

/**
 * M4-D: boot-time driver-truth probe for the REAL path. A persisted
 * `waiverAccepted: true` can be STALE - the driver-side waiver
 * (ctlOverclockWaiverSet) can be lost (reinstall, IGS reset) while
 * settings.json still says accepted. IGCL exposes no waiver getter, so the
 * only honest check is a write: apply the device's CURRENT power limit (a
 * no-op value write) and read the outcome.
 *
 * M4-D (PERMANENT acceptance): when the driver answers waiver-not-set
 * while the persisted acceptance is TRUE, the elevated boot probe now
 * RESTORES the driver waiver (backend.setWaiverAccepted) instead of
 * clearing the store - the persisted acceptance is the user's permanent
 * consent, it stands until the user revokes it, and the store is never
 * flipped to false on a driver refusal (persistWaiverLost is REMOVED). The
 * probe writes nothing else. When the store says unaccepted, the behavior
 * is unchanged (the in-memory flag + store are cleared to false so the
 * classic Accept dialog shows).
 *
 * The write is value-neutral (current value -> current value) and only
 * ever surfaces the waiver truth. Call AFTER seedWaiverState, before the
 * renderer boots.
 *
 * @param {import('./backend/backend.interface.js').IOCBackend} backend
 * @param {import('./store/profile-store.js').ProfileStore} store
 */
export async function probeWaiverState(backend, store) {
  const devices = await backend.listDevices();
  for (const device of devices) {
    const caps = await backend.getCapabilities(device.id);
    if (!caps?.ranges?.powerLimitW) continue; // no probe control on this device
    const state = await backend.getCurrentSettings(device.id);
    if (typeof state?.powerLimitW !== 'number') continue;
    // Backends return the apply result directly ({ ok, perControl }).
    const out = await backend.applySettings(device.id, { powerLimitW: state.powerLimitW });
    const per = out?.perControl?.powerLimitW;
    if (per?.ok === false && per.errorCode === 'waiver-not-set') {
      let persistedAccepted = false;
      try {
        persistedAccepted = (await store.loadSettings()).waiverAccepted === true;
      } catch {
        // degraded: treat as unaccepted - never restore on an unknown store
      }
      if (persistedAccepted) {
        // M4-D: the consent stands - RESTORE the driver waiver (elevated
        // boot probe). setWaiverAccepted also re-sets the in-memory flag.
        await backend.setWaiverAccepted(device.id);
      } else {
        // Unaccepted store: unchanged M4-B behavior - clear the in-memory
        // flag AND the persisted store so the boot prompt shows the classic
        // Accept dialog.
        await backend.restoreWaiverState(device.id, false);
        const settings = await store.loadSettings();
        await store.saveSettings({ ...settings, waiverAccepted: false });
      }
    }
  }
}

/**
 * M3-C review F3: seed the backend's OC mode from the persisted settings
 * (settings.json via the store). Must run BEFORE the window/IPC exist - the
 * renderer's FIRST getCapabilities must already see the right range set (a
 * persisted-advanced session must never render 252 W / 90 C sliders until a
 * later self-heal). setOcMode is an in-memory caps-cache invalidation, safe
 * before init(). Returns the seeded mode, or null when the store read fails
 * (degraded: the backend keeps its construction default - bootBackend's own
 * seeding runs again later, and the mode toggle re-seeds on demand).
 * @param {import('./backend/backend.interface.js').IOCBackend} backend
 * @param {import('./store/profile-store.js').ProfileStore} store
 * @returns {Promise<'stock'|'advanced'|null>}
 */
export async function seedOcMode(backend, store) {
  try {
    const s = await store.loadSettings();
    if (typeof backend.setOcMode === 'function') backend.setOcMode(s.ocMode);
    // M157: restore keyed modes after the adapter inventory is available.
    // The scalar remains the backwards-compatible fallback for old settings
    // files and for the short pre-inventory seed.
    if (s.ocModes && typeof s.ocModes === 'object' && typeof backend.listDevices === 'function') {
      try {
        const devices = await backend.listDevices();
        for (const device of devices) {
          const mode = typeof device?.deviceKey === 'string' ? s.ocModes[device.deviceKey] : null;
          if ((mode === 'stock' || mode === 'advanced') && typeof backend.setOcMode === 'function') {
            await backend.setOcMode(mode, device.id);
          }
        }
      } catch {
        // The pre-window call can occur before backend enumeration. The
        // post-init boot call repeats this keyed restore.
      }
    }
    return s.ocMode;
  } catch {
    return null;
  }
}

/**
 * Channels that take no payload must never receive one (the preload only
 * calls them bare, but the whitelist is the enforcement point).
 */
export function assertNoPayload(args, channel) {
  if (args.length > 0) {
    throw new Error(`${channel} takes no payload`);
  }
}

/**
 * M151: classify an adapter for the startup focus preference. Explicit IGCL
 * integrated metadata is authoritative; synthetic OS-only rows may not carry
 * that bit, so their conservative name classification remains available.
 * This is a preference only - it never authorizes a write or replaces the
 * stable physical identity checks used by routing.
 */
function isIntegratedFocusDevice(device) {
  if (device?.integrated === true) return true;
  if (device?.synthetic !== true && device?.integrated === false) return false;
  const name = String(device?.name ?? '');
  if (isIntegratedStyleDevice(device)) return true;
  return /\b(?:igpu|integrated)\b/i.test(name)
    || /\b(?:amd\s+)?radeon(?:\s*\([^)]*\))?\s+graphics\b/i.test(name)
    || /\b(?:radeon|vega)(?:\s*\([^)]*\))?\s+\d{3,4}m\b/i.test(name);
}

function automaticIdentityOf(device) {
  return typeof device?.deviceKey === 'string' && device.deviceKey.length > 0
    ? device.deviceKey
    : deviceHardwareKey(device);
}

function uniqueAutomaticDevices(devices) {
  const counts = new Map();
  for (const device of devices) {
    const identity = automaticIdentityOf(device);
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  return devices.filter((device) => device?.identityAmbiguous !== true
    && counts.get(automaticIdentityOf(device)) === 1);
}

/**
 * M151: choose the generic startup focus target. A discrete adapter is always
 * preferred when one exists; among discrete adapters, one with at least one
 * active display output wins. If no discrete adapter exists, the same active
 * output preference is used across the remaining adapters. Durable identity
 * is the deterministic tie-breaker, with the session id used only when two
 * rows expose the same identity.
 *
 * The display API is best-effort and read-only. Unsupported vendor backends,
 * missing symbols, and transient output failures simply fall back to the
 * discrete-first choice. No GPU model or vendor is hardcoded here.
 */
export async function resolvePreferredDevice(backend, devices = null) {
  const rows = Array.isArray(devices)
    ? devices
    : typeof backend?.listDevices === 'function' ? await backend.listDevices() : [];
  if (rows.length === 0) return null;

  const known = uniqueAutomaticDevices(rows);
  const allDiscrete = rows.filter((device) => !isIntegratedFocusDevice(device));
  const discrete = uniqueAutomaticDevices(allDiscrete);
  // An ambiguous dGPU must never cause an iGPU to be selected by ordinal.
  // If every dGPU is ambiguous, there is no safe automatic focus target.
  const candidates = allDiscrete.length > 0 ? discrete : known;
  if (candidates.length === 0) return null;
  const activeIds = new Set();
  if (typeof backend?.getDisplaySettings === 'function') {
    await Promise.all(candidates.map(async (device) => {
      if (device?.displayActive === true || device?.osController?.displayActive === true) {
        activeIds.add(device.id);
        return;
      }
      try {
        const state = await backend.getDisplaySettings(device.id);
        const displays = Array.isArray(state?.displays) ? state.displays : [];
        if (displays.some((display) => display?.flags?.active === true)) activeIds.add(device.id);
      } catch {
        // An unsupported or transient display read must not block startup.
      }
    }));
  }

  return candidates
    .map((device, index) => ({ device, index }))
    .sort((a, b) => {
      const activeDiff = Number(activeIds.has(b.device.id)) - Number(activeIds.has(a.device.id));
      if (activeDiff !== 0) return activeDiff;
      const keyA = typeof a.device.deviceKey === 'string' && a.device.deviceKey.length > 0
        ? a.device.deviceKey : deviceHardwareKey(a.device);
      const keyB = typeof b.device.deviceKey === 'string' && b.device.deviceKey.length > 0
        ? b.device.deviceKey : deviceHardwareKey(b.device);
      const keyDiff = keyA.localeCompare(keyB);
      return keyDiff !== 0 ? keyDiff : a.index - b.index;
    })[0]?.device ?? null;
}

/** M151: id-only convenience seam for tests and callers that need no key. */
export async function resolvePreferredDeviceId(backend, devices = null) {
  return (await resolvePreferredDevice(backend, devices))?.id ?? null;
}

/**
 * M29: resolve the boot device by durable PCI/BDF identity. A legacy
 * numeric-only setting is deliberately unverified after reorder, so the
 * sorted preferred device is chosen and both identity fields are healed.
 * A persisted durable key that disappeared is refused without rewriting it;
 * boot profile application must never retarget another GPU.
 */
export async function resolveBootDeviceId(backend, store) {
  const devices = await backend.listDevices();
  if (devices.length === 0) return null;
  const keyed = devices.map((d) => ({ ...d, deviceKey: d.deviceKey ?? deviceHardwareKey(d) }));
  let settings = null;
  try {
    settings = await store.loadSettings();
  } catch {
    // degraded: never re-persist over an unreadable store
  }
  const persistedKey = typeof settings?.deviceKey === 'string' ? settings.deviceKey : null;
  const exactMatches = persistedKey ? keyed.filter((d) => d.deviceKey === persistedKey) : [];
  if (exactMatches.length > 1) return null;
  let matched = exactMatches[0] ?? null;
  let reconciledPnp = false;
  // M45: the raw --boot-apply backend enumerates PCI/BDF rows, while the
  // window path persists a PNP-first inventory key. Reconcile only a PNP
  // key whose vendor/device pair identifies exactly one current writable
  // row. A missing or ambiguous pair is stale: choosing by ordinal would
  // risk applying the profile to another adapter.
  if (!matched && persistedKey) {
    const pnp = pnpParts(persistedKey);
    if (pnp) {
      const normalizePciId = (value) => {
        const text = typeof value === 'number' && Number.isInteger(value)
          ? value.toString(16)
          : typeof value === 'string' ? value.trim().replace(/^0x/i, '') : '';
        return /^[0-9a-f]{1,8}$/i.test(text) ? `0x${text.toLowerCase().slice(-4).padStart(4, '0')}` : null;
      };
      const candidates = keyed.filter((device) => device.synthetic !== true
        && device.backendKind !== 'os'
        && device.identityAmbiguous !== true
        && normalizePciId(device.pciVendorId) === pnp.ven
        && normalizePciId(device.pciDeviceId) === pnp.dev
        && (!pnp.subsys || pnp.subsys === '00000000'
          || (normalizePciId(device.pciSubsysVendorId) === `0x${pnp.subsys.slice(4).toLowerCase()}`
            && normalizePciId(device.pciSubsysId) === `0x${pnp.subsys.slice(0, 4).toLowerCase()}`)));
      if (candidates.length === 1) {
        matched = candidates[0];
        reconciledPnp = true;
      } else if (candidates.length > 1) return null;
      else return null;
    }
  }
  // A persisted durable identity is an explicit write target. If it has
  // disappeared, refuse boot resolution rather than self-healing to another
  // GPU before apply-on-boot gets its stale-target refusal.
  if (persistedKey && !matched) return null;
  const resolvedDevice = matched ?? keyed[0];
  if (settings && (settings.deviceId !== resolvedDevice.id || (!reconciledPnp && settings.deviceKey !== resolvedDevice.deviceKey))) {
    try {
      await store.saveSettings({
        ...settings,
        deviceId: resolvedDevice.id,
        // Keep the PNP-first inventory identity durable even though this
        // raw backend selected a PCI/BDF row for this boot.
        deviceKey: reconciledPnp ? settings.deviceKey : resolvedDevice.deviceKey,
      });
    } catch (err) {
      console.log(`[boot] device selection self-heal persist skipped: ${err.message}`);
    }
  }
  return resolvedDevice.id;
}

/**
 * Build the handler map for every whitelisted channel.
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   store: import('./store/profile-store.js').ProfileStore,
 *   emit: (channel: string, payload: unknown) => void,
 *   startup?: { get: () => Promise<{ valueExists: boolean, value: string | null }>, set: (enabled: boolean) => Promise<unknown> },
 *   driverInfo?: { get: () => Promise<{ driverDate: string | null }> },
 *   sysinfo?: { get: () => Promise<unknown> },  // M4-D: CIM system info (CPU/RAM/video controllers)
 *   windowOps?: {                              // M4-D: injected BrowserWindow ops (title-bar buttons)
 *     minimize: () => Promise<unknown>,
 *     maximizeToggle: () => Promise<unknown>,
 *     close: () => Promise<unknown>,
 *   },
 *   openExternal?: (url: string) => Promise<unknown>,  // M4-H: injected shell.openExternal (the sidebar GitHub link)
 *   registryCatalog?: { get: () => Promise<unknown> },  // M3-A read-side catalog
 *   registryApply?: { apply: (entryId: string, action: string) => Promise<unknown> },  // M3-B elevated apply
 *   fpsAdapter?: { poll: (deviceId: number) => Promise<{ fps: number | null, frameTimeMs: number | null, gpuBusy: number | null, avgFps: number | null, low1Pct: number | null, low01Pct: number | null, p99: number | null } | null>, stop?: () => Promise<void> },
 *   presentMonLane?: { poll: (deviceId: number) => Promise<object | null>, stop?: () => Promise<void> } | null,  // M17c: the ETW/PresentMon lane (the PREFERRED FPS source; M17d: wraps the pm-service + sidecar SOURCE CHAIN; null in mock/tests - the determinism seam like foregroundApi)
 *   foregroundApi?: { detect: () => Promise<string | null> },  // M10a: the foreground-window Graphics-API detector (the DEFAULT is the null-returning detector - mock/ui-verify never run the real probe)
 *   memoryUtil?: { detect: () => Promise<number | null> },  // M12/M14: the RAM detector (GlobalMemoryStatusEx -> the USED RAM in BYTES - total - avail; the DEFAULT is the null-returning detector - mock/ui-verify never run the real koffi probe). M17g: the emit-site composition MOVED into the sysStats adapter's FAST lane - this param is kept for call-site compatibility and is no longer consumed by the telemetry push (the fast-lane field replaces it).
 *   sysStats?: { sample: () => Promise<{ cpuUtilPct: number | null, cpuTempC: number | null, cpuFreqMhz: number | null, gpuMemUsedBytes: number | null }>, sampleFast?: () => Promise<object>, sampleSlow?: () => Promise<object>, setTarget?: (target?: object|null) => void, startSlowLane?: (cadenceMs?: number) => void, stopSlowLane?: () => void } | { current: object | null },  // M4-D2: CPU/GPU system stats (OS-formatted counters, single-sample). M17g: the telemetry push samples the FAST lane (sampleFast) per tick - never the slow PowerShell query; the slow lane runs on the adapter's own background timer (startSlowLane/stopSlowLane, tied to the telemetry session lifecycle). M17p: main.js may pass a MUTABLE HOLDER ({ current: null } - the sysStats block lands AFTER registerIpc; the ONE normalize at the top unwraps it per-access; a plain adapter passes through).
 *   monitorLog?: { append: (sample: object) => Promise<{ ok: boolean, error?: string }> },  // M4-D2: log-to-file writer (monitor-YYYYMMDD.txt)
 *   rebuildTray?: () => Promise<unknown>,
 *   appVersion?: string,
 *   appLifecycle?: { clearCacheAndRestart: () => Promise<{ ok: boolean, restarting: boolean }> },
 *   buildKind?: 'installed' | 'portable' | 'dev' | 'unknown',  // M4-E: app:build-info
 *   portableWrapperPath?: string | null,  // M98: validated portable wrapper target shared by classification and replacement
 *   startupUpdateCheck?: (options: { buildKind: string, intent: 'startup' | 'manual' }) => Promise<object>,
 *   bootApplyOutcome?: () => ({ ok: boolean, detail: string, at: number } | null),  // M4N: the window-path boot apply's outcome record (main.js injects it; null when no boot apply ran this session)
 *   oldIgcl?: object,            // bundled-2023-runtime adapter (apply-routing)
 *   applyRunner?: object|null,   // elevation-aware apply runner (elevated-apply)
 *   isElevated?: () => boolean,  // elevation probe for the app-elevated channel
 *   mock?: {                     // M2D: mock-only featureset control. When null
 *                                // (real mode) the mock:* channels are NOT
 *                                // registered at all - an honest 404.
 *     listFeaturesets: () => Promise<{ featuresets: Array<{id: string, name: string, tag: string}>, current: string }>,
 *     setFeatureset: (id: string) => Promise<{ featureset: object, devices: object[], caps: object, state: object, health: object, driverDate: string | null }>,
 *     // M4-D2: run the REAL window-path boot-apply code path in mock mode
 *     // (applyRunner-less variant, fallback skipped) + read the mock
 *     // boot-apply log (what the boot apply recorded). ui-verify pins the
 *     // flow through these channels.
 *     runBootApply: () => Promise<{ applied: boolean, reason: string, log: object[] }>,
 *     bootApplyLog: () => Promise<object[]>,
 *   } | null,
 *   overlayOps?: {                 // M5: the injected overlay-window ops (the
 *                                  // windowOps pattern). main.js wires the
 *                                  // real overlay handle; the DEFAULT is the
 *                                  // honest "no overlay window" state (tests
 *                                  // and non-overlay ui-verify variants).
 *     getState: () => Promise<{ exists: boolean, visible: boolean, bounds: object|null, position: string, scale: number, enabled: boolean, hotkeyRegistered: boolean }>,
 *     toggle: () => Promise<unknown>,
 *   },
 *   onOverlaySettings?: (patch: object) => Promise<unknown>,  // M5: the overlay
 *                                  // settings reaction (the rebuildTray
 *                                  // pattern) - called when profiles-settings-
 *                                  // save changed any overlay field; main.js
 *                                  // applies geometry/visibility/hotkey + sends
 *                                  // 'overlay:settings' to the overlay window.
 *   advancedOverlayOps?: {         // M23: the injected ADVANCED-overlay-window
 *                                  // ops (the overlayOps pattern - the M5 HUD
 *                                  // seam, new names). main.js wires the real
 *                                  // panel handle; the DEFAULT is the honest
 *                                  // "no panel" state (tests + non-advanced
 *                                  // variants).
 *     getState: () => Promise<{ exists: boolean, visible: boolean, bounds: object|null, position: 'left'|'right', enabled: boolean, hotkeyRegistered: boolean }>,
 *     toggle: () => Promise<unknown>,
 *   },
 *   advancedOverlayClose?: () => Promise<unknown>,  // M23: the panel's custom
 *                                  // close op (the dedicated
 *                                  // 'advanced-overlay-close' channel - the
 *                                  // main window is never closed by the
 *                                  // panel; the DEFAULT is a no-op).
 *   onAdvancedOverlaySettings?: (patch: object) => Promise<unknown>,  // M23:
 *                                  // the advanced-overlay settings reaction
 *                                  // (the onOverlaySettings pattern) - called
 *                                  // when profiles-settings-save changed any
 *                                  // advancedOverlay* field; main.js applies
 *                                  // geometry/visibility/hotkey + sends
 *                                  // 'advanced-overlay:settings' to the panel.
 * }} ctx
 */
export function createIpcHandlers({
  backend,
  store,
  emit,
  startup = createMockStartup(),
  driverInfo = createMockDriverInfo(),
  // M4-D: the sysinfo adapter. The DEFAULT is the MOCK fixture (never
  // spawns PowerShell); main.js injects the cached CIM result in the
  // product path.
  sysinfo = createMockSysinfo(),
  // M4-D: the injected BrowserWindow ops for the integrated title bar. The
  // DEFAULT is no-ops (tests + mock mode never touch a real window);
  // main.js wires the real BrowserWindow in the product path (and counting
  // probes in --ui-verify mode).
  windowOps = {
    minimize: async () => {},
    maximizeToggle: async () => {},
    close: async () => {},
  },
  // M4-H (D1): the injected shell.openExternal op (the sidebar GitHub
  // link). The DEFAULT is a no-op (tests + mock mode never open a browser);
  // main.js wires shell.openExternal in the product path (and a counting
  // probe in --ui-verify mode).
  openExternal = async () => {},
  // M3-A: the registry-catalog adapter. The DEFAULT is the MOCK (never runs
  // reg.exe); ipc.js injects the real adapter in the product path. The
  // catalog is read-side only - the M3-B apply channel is 'registry-apply'.
  registryCatalog,
  // M3-B: the registry-apply adapter. The DEFAULT is the MOCK (never spawns
  // PowerShell, never elevates); ipc.js injects the real adapter in the
  // product path. The mock catalog + mock apply SHARE one mock registry
  // state so an applied action is honestly reflected by the next
  // registry-catalog read (the post-apply state refresh).
  registryApply,
  // M4-D2: the system-stats adapter (CPU util/freq/temp + GPU memory).
  // The DEFAULT is the MOCK (fixed deterministic values, never spawns
  // PowerShell - ui-verify pins are deterministic); ipc.js injects the
  // real rolling-delta adapter in the product path. sample() is called on
  // every telemetry tick; its values ride the pushed telemetry sample.
  sysStats = createMockSysStats(),
  // M4-D2: the log-to-file writer (monitor-YYYYMMDD.txt). The DEFAULT is a no-op (tests never
  // write to Documents); ipc.js injects the real writer in the product
  // path (dir: RID_MOCK_LOG_DIR ?? app.getPath('documents')).
  monitorLog = { append: async () => ({ ok: true }) },
  // M2b-B: the FPS adapter. The DEFAULT is the mock (always unavailable -
  // never loads koffi/dxgi); ipc.js injects the real DXGI adapter in the
  // product path. On this machine the real adapter may also degrade to
  // null (DXGI unavailable), so mock and product agree on 'unavailable'.
  fpsAdapter = { poll: async () => null },
  // M17c: the ETW/PresentMon lane - the PREFERRED FPS source when it has a
  // fresh sample (the game's own present rate via the dxgkrnl ETW stream);
  // the fps-poll handler consults it FIRST and falls back to fpsAdapter
  // (the DXGI desktop-presentation tier) when the lane is idle/absent.
  // THE DETERMINISM SEAM (the foregroundApi pattern): the DEFAULT is null
  // (tests + mock/ui-verify never run the sidecar or the foreground-pid
  // probe); main.js wires the real lane ONLY in the non-mock product path.
  presentMonLane = null,
  // M10a: the foreground-window Graphics-API detector (the overlay's FPS-row
  // badge). The DEFAULT is the null-returning detector (tests + mock/
  // ui-verify NEVER run the real koffi probe - the determinism seam:
  // main.js wires the real detector ONLY in the non-mock path); the
  // ipc-core fps-poll handler composes its result into the sample.
  foregroundApi = { detect: async () => null },
  // M12: the RAM-utilization detector (GlobalMemoryStatusEx -> the USED
  // RAM in BYTES - total - avail - the Memory row's source). The DEFAULT
  // is the null-returning detector (the same determinism seam: main.js
  // wires the real detector ONLY in the non-mock path; the mock fixture's
  // memoryUsedBytes 12400000000 wins over it - the fixture-wins
  // composition); the ipc-core telemetry emit sites compose its result
  // into the pushed sample.
  memoryUtil = { detect: async () => null },
  rebuildTray = async () => {},
  appVersion = PKG_VERSION,
  // M52: injected app lifecycle seam; default/test action does not exit.
  appLifecycle = { clearCacheAndRestart: async () => ({ ok: false, restarting: false }) },
  // M4-E: the distribution kind for the app:build-info channel ('dev' in
  // tests; main.js injects 'installed' | 'portable' | 'dev').
  buildKind = 'dev',
  portableWrapperPath = null,
  startupUpdateCheck = null,
  // M4N (A.1): the window-path boot apply's outcome record (main.js
  // injects the session record; null when no boot apply ran this session -
  // the DEFAULT is null, tests never have a boot apply).
  bootApplyOutcome = () => null,
  // M2C-C: the 2023-runtime adapter + the elevation-aware apply runner.
  // Defaults: a no-op old runtime (never loads the DLL) and no runner
  // (applies run in-process) - safe for tests and mock mode.
  oldIgcl = createNullOldIgcl(),
  applyRunner = null,
  isElevated = detectElevated,
  mock = null,
  // M5: the injected overlay-window ops. The DEFAULT is the honest
  // "no overlay window" state (tests + non-overlay variants never have one);
  // main.js wires the real overlay handle in the product path + the
  // RID_MOCK_OVERLAY=1 ui-verify variant.
  overlayOps = {
    getState: async () => ({ exists: false, visible: false, bounds: null, position: 'top-left', scale: 1, enabled: false, hotkeyRegistered: false }),
    toggle: async () => {},
    resize: async () => {},
  },
  // M5: the overlay settings reaction (the rebuildTray pattern) - called
  // when profiles-settings-save changed any overlay field. The DEFAULT is
  // a no-op; main.js applies the geometry/visibility/hotkey + sends
  // 'overlay:settings' DIRECTLY to the overlay window.
  onOverlaySettings = async () => {},
  // M23: the injected ADVANCED-overlay-window ops (the M5 overlayOps seam,
  // new names - the AMD-Adrenaline-style interactive side panel). The
  // DEFAULT is the honest "no panel" state (tests + non-advanced variants
  // never have one); main.js wires the real panel handle in the product
  // path + the RID_MOCK_ADV_OVERLAY=1 ui-verify variant.
  advancedOverlayOps = {
    getState: async () => ({ exists: false, visible: false, bounds: null, position: 'right', enabled: false, hotkeyRegistered: false }),
    toggle: async () => {},
  },
  // M23: the advanced-overlay settings reaction (the onOverlaySettings
  // pattern) - called when profiles-settings-save changed any
  // advancedOverlay* field. The DEFAULT is a no-op; main.js applies the
  // geometry/visibility/hotkey + sends 'advanced-overlay:settings'
  // DIRECTLY to the panel window.
  onAdvancedOverlaySettings = async () => {},
  // M23: the panel's custom close op - the dedicated 'advanced-overlay:close'
  // channel's handler (the DEFAULT is a no-op; main.js wires it to the panel
  // handle's session hide - the main window is never closed by the panel).
  advancedOverlayClose = async () => {},
  // M17f: the sysman power-limits consumer (src/main/sysman/power-limits.js)
  // - the PL2 companion + the 'power-limits:read' channel source. The
  // DEFAULT is null (tests/mock degrade to the honest '-' read-out + no
  // companion); main.js wires the REAL adapter in the product path and the
  // MOCK seam in mock/ui-verify mode.
  sysmanPowerLimits = null,
  // M17c: the vendor-telemetry lane (non-Intel GPU readouts - the
  // no-device telemetry path's hook). The DEFAULT resolves the NVML/ADL
  // adapter from the sysinfo controller vendor (RID_MOCK_VENDOR=nvml|adl
  // substitutes the fixture adapter for tests/ui-verify); an absent DLL
  // degrades to the null adapter - honest no vendor readouts, never a
  // crash.
  vendorTelemetry = createVendorTelemetry({ sysinfo }),
  vendorTelemetryFactory = null,
  gameProfiles = null,
  gameScan = createGameScanAdapter(),
  chooseGameExecutable = async () => null,
  gameArtwork = async () => null,
  recordingStore = null,
  recordingEngine = null,
  chooseRecordingDirectory = async () => null,
  openRecordingFolder = async () => {},
  refreshRecordingHotkeys = async () => null,
  getRecordingHotkeyState = () => ({ registered: {}, conflicts: {}, error: null }),
  recordingProcessList = null,
  recordingCaptureTargets = null,
}) {
  // D2: the real app injects its sidecar store, while tests can provide an
  // in-memory adapter. The fallback is isolated to the ProfileStore data
  // directory and is never consulted unless a game-profile channel is used.
  if (!gameProfiles) {
    gameProfiles = store?.dir ? new GameProfileStore({ dir: store.dir }) : {
      _items: [],
      _catalog: [],
      _settings: [],
      async load(validIds) { return this._items.filter((item) => !validIds || validIds.has(item.profileId)); },
      async upsert(item) { this._items = [...this._items.filter((x) => !(x.profileId === item.profileId && x.exePath === item.exePath)), item]; return this._items; },
      async delete(profileId, exePath) { this._items = this._items.filter((x) => !(x.profileId === profileId && x.exePath === exePath)); return this._items; },
      async cleanupProfile(profileId) {
        this._items = this._items.filter((x) => x.profileId !== profileId);
        this._settings = this._settings.map((item) => ({
          ...item,
          tuningProfileId: item.tuningProfileId === profileId ? null : item.tuningProfileId,
          gpuProfiles: Array.isArray(item.gpuProfiles) ? item.gpuProfiles.map((assignment) => assignment.tuningProfileId === profileId
            ? { ...assignment, tuningProfileId: null }
            : assignment) : item.gpuProfiles,
        }));
        return this._items;
      },
      async loadCatalog() { return { catalog: this._catalog, settings: this._settings }; },
      async syncCatalog(entries) { this._catalog = [...this._catalog, ...entries.filter((entry) => !this._catalog.some((x) => x.exePath === entry.exePath))]; return this._catalog; },
      async addCatalogEntry(entry) { this._catalog = [...this._catalog.filter((x) => x.exePath !== entry.exePath), entry]; return { catalog: this._catalog, settings: this._settings }; },
      async saveSettings(item) { this._settings = [...this._settings.filter((x) => x.exePath !== item.exePath), item]; return item; },
      async deleteSettings(exePath) { this._settings = this._settings.filter((x) => x.exePath !== exePath); return { catalog: this._catalog, settings: this._settings }; },
    };
  }
  // D2: legacy profile deletion and sidecar association mutations share one
  // main-process gate.  The two stores remain separate files, but no queued
  // association save can validate a profile and then land after that profile
  // has been deleted.
  let gameProfileMutation = Promise.resolve();
  const serializeGameProfileMutation = (work) => {
    const next = gameProfileMutation.then(work, work);
    gameProfileMutation = next.catch(() => {});
    return next;
  };
  // M17p: the sysStats by-value capture fix (S4/N1-r2) - THE ONE NORMALIZE
  // at the top (the plan's unwrap expression): main.js passes a MUTABLE
  // HOLDER ({ current: null } - the sysStats block lands AFTER registerIpc,
  // so the adapter is assigned into the holder after this call; a by-value
  // capture here would freeze null forever). A holder-shaped sysStats is
  // rebound to a per-access forwarding shim - the telemetry and target
  // selection consumption sites
  // (the no-device + device telemetry pushes + the slow-lane lifecycle)
  // and the defaults + the plain-adapter tests stay untouched; a plain
  // adapter passes through unchanged. The shim is null-safe: before the
  // holder lands (never in practice - telemetry starts after the block),
  // a call degrades to undefined, which the sites' try/catch swallow.
  let reconcileSysStatsReady = async () => {};
  if (sysStats && typeof sysStats === 'object' && 'current' in sysStats) {
    const holder = sysStats;
    const previousReady = typeof holder.onReady === 'function' ? holder.onReady : null;
    holder.onReady = () => {
      try { previousReady?.(); } catch { /* readiness hooks are best effort */ }
      void reconcileSysStatsReady().catch(() => {});
    };
    sysStats = {
      sample: (...args) => holder.current?.sample?.(...args),
      sampleFast: (...args) => holder.current?.sampleFast?.(...args),
      sampleForTarget: (...args) => holder.current?.sampleForTarget?.(...args),
      registerTarget: (...args) => holder.current?.registerTarget?.(...args),
      sampleSlow: (...args) => holder.current?.sampleSlow?.(...args),
      setTarget: (...args) => holder.current?.setTarget?.(...args),
      startSlowLane: (...args) => holder.current?.startSlowLane?.(...args),
      stopSlowLane: (...args) => holder.current?.stopSlowLane?.(...args),
    };
  }
  // M3-A/M3-B mock defaults: the read + apply mock adapters share ONE mock
  // registry state (in-memory; never touches the real registry), so a mock
  // apply flips the very next mock read. When either adapter is injected,
  // both are product/real or test-injected - a shared state is only built
  // for the default pair.
  const mockRegistryState = registryCatalog && registryApply ? null : createMockRegistryState();
  const catalogAdapter = registryCatalog ?? createMockRegistryCatalog(REGISTRY_CATALOG, { state: mockRegistryState });
  const registryApplyAdapter = registryApply ?? createMockRegistryApply(REGISTRY_CATALOG, { state: mockRegistryState });
  /**
   * 1.0.1 no-Intel round (m3): the SENTINEL key for the no-device telemetry
   * mode (telemetry-start(null)) in the shared telemetry Map. A real device
   * id is always a non-negative integer, so -1 can never collide.
   */
  const NULL_DEVICE_KEY = -1;
  // Main-renderer selection pushes carry a monotonic session generation. This
  // remains in memory even when deviceSet could not persist the new choice.
  let latestMainSelectionGeneration = -1;
  /** @type {Map<number, TelemetryService | { stop: () => Promise<void> }>} */
  const telemetry = new Map();
  /** The most recent fully composed sample for each active telemetry lane.
   * The advanced overlay can open between timer ticks, so it needs a
   * read-on-demand snapshot in addition to the push stream. */
  const latestTelemetry = new Map();
  // Settings patches are read-modify-write operations. Serialize them so a
  // Monitoring log toggle cannot be overwritten by an unrelated Settings,
  // Profiles, or Overlay save that started from the previous snapshot.
  let settingsSaveQueue = Promise.resolve();
  const emitTelemetry = (payload) => {
    const key = Number.isInteger(payload?.deviceId) ? payload.deviceId : NULL_DEVICE_KEY;
    latestTelemetry.set(key, payload);
    emit('telemetry:sample', payload);
  };
  // M151: device-preferred-get may be called concurrently by the main window
  // and either overlay. Deduplicate only the currently running probe. Do not
  // retain a completed result: active display topology can change without an
  // inventory id/name change, so every later request must re-read it.
  let preferredSelectionPromise = null;
  const preferredSelection = async () => {
    if (preferredSelectionPromise) return preferredSelectionPromise;
    const promise = (async () => {
      const devices = await backend.listDevices();
      const device = await resolvePreferredDevice(backend, devices);
      return {
        deviceId: device?.id ?? null,
        deviceKey: typeof device?.deviceKey === 'string' && device.deviceKey.length > 0
          ? device.deviceKey : device ? deviceHardwareKey(device) : null,
      };
    })();
    preferredSelectionPromise = promise;
    try {
      return await promise;
    } finally {
      if (preferredSelectionPromise === promise) preferredSelectionPromise = null;
    }
  };
  /** Overlay-only secondary GPU services. The main renderer keeps one
   * selected-device service; the HUD may additionally subscribe to every
   * other inventory row without changing the selected-device state flow. */
  const overlayTelemetry = new Map();
  // Vendor telemetry factories own their adapter instance. Overlay OS-only
  // rows therefore use independent lanes instead of rebinding the main
  // renderer's singleton adapter.
  const stopOverlayTelemetry = async () => {
    // Snapshot + clear before awaiting: a newer start may install lanes while
    // an older teardown is still closing its services; it must not close the
    // newer map entries.
    const services = [...overlayTelemetry.values()];
    overlayTelemetry.clear();
    for (const svc of services) {
      try { await svc.stop?.(); } catch { /* best effort */ }
    }
  };
  let telemetryGeneration = 0;
  let overlayTelemetryGeneration = 0;
  const cleanupStaleTelemetryStartup = async ({ generation, timer = null, vendor = null, service = null }) => {
    if (generation === telemetryGeneration) return false;
    clearInterval(timer);
    try { await service?.stop?.(); } catch { /* stale startup */ }
    try { await vendor?.close?.(); } catch { /* stale startup */ }
    // A deferred slow-lane start can arm its timer after telemetry-stop has
    // already returned. Pass the startup generation so an adapter that tracks
    // ownership cannot tear down a newer session's lane.
    try { await sysStats.stopSlowLane?.(generation); } catch { /* stale startup */ }
    return true;
  };


  /**
   * 1.0.1 no-Intel round: the no-device telemetry mode - a sentinel-keyed
   * timer pushing sys-stats-ONLY samples (t: Date.now() + the 4 sys-stats
   * fields, all OS-level counters that work on ANY GPU). The device
   * telemetry fields are absent, so the GPU tiles/readouts honestly stay
   * '-' while the CPU util/temp + GPU-memory tiles go live. Same cadence
   * as the device TelemetryService (the overlay polling-rate - the
   * store's overlayPollMs, default 400 ms - M17g: the stock polling rate
   * FLIPS 500 -> 400; M17e round-2 N3); the
   * boot-level log-to-file subscription consumes the same telemetry:sample
   * push, so log-file logging works for free.
   * M14: the sample CARRIES the used-RAM-bytes field from the sysStats
   * adapter's FAST lane (the M17g move - the emit-site composition is
   * replaced by the fast-lane field; the fixture's memoryUsedBytes
   * 12400000000 rides the push while the null-returning mock detector
   * stays unrun). The M17c vendor used-VRAM still wins over it (the
   * device-wins precedence - the NVML used-VRAM is the better source on
   * NVIDIA).
   * M17g: the push samples the FAST lane per tick (ms-fast native reads,
   * never PowerShell) and emits IMMEDIATELY with the merged cache
   * (fast ?? slow); the slow PowerShell query is NEVER awaited inline -
   * the slow lane runs on the adapter's own background timer
   * (startSlowLane/stopSlowLane, tied to the telemetry session
   * lifecycle - stopped with stopAllTelemetry).
   */
  const startNullTelemetry = async () => {
    const active = telemetry.get(NULL_DEVICE_KEY);
    if (active) {
      // A renderer may attach after another window started null/focus-
      // unavailable mode. Refresh the shared lane so its first snapshot is
      // available immediately instead of waiting for the next interval.
      try { await active.sampleNow?.(); } catch { /* retain the live lane */ }
      return;
    }
    const generation = ++telemetryGeneration;
    // M17e (round-2 N3): the no-Intel lane honors the overlay polling-rate
    // slider too - the SAME store read as startTelemetry (the pollMs is
    // read ONCE at start; a change RESTARTS the null push with the new
    // interval via the live-restart reaction below).
    let pollMs = OVERLAY_POLL_MS_DEFAULT;
    try {
      const s = await store.loadSettings();
      pollMs = clampOverlayPollMs(s.overlayPollMs);
    } catch {
      // a store read failure keeps the default cadence
    }
    if (generation !== telemetryGeneration) return;
    // M17c: the vendor-telemetry lane - the no-device path hook. When the
    // ACTIVE device is non-Intel, the sysinfo controller vendor selects
    // the first available of [NVML, ADL] matching it; the adapter's
    // readouts (gpuClockMhz/tempC/utilPct/powerW/gpuMemUsedBytes/fanRpm -
    // the TelemetrySample shape) compose into the pushed sample, so the
    // overlay/monitoring render stays unchanged. Absent DLL / no vendor ->
    // null adapter (the honest '-' per field - never a crash).
    let vendor = null;
    try {
      vendor = await vendorTelemetry.start();
    } catch {
      vendor = null; // a lane failure must never break the no-device timer
    }
    if (await cleanupStaleTelemetryStartup({ generation, vendor })) return;
    const sampleNow = async () => {
      // M17g: sample the FAST lane per tick (ms-fast:
      // GetSystemTimes/MSR/GlobalMemoryStatusEx - never PowerShell) and merge
      // the slow-lane cache. Each source degrades independently so one
      // unavailable probe does not suppress an otherwise useful first sample.
      let extra = {};
      try { extra = await sysStats.sampleFast(); } catch { /* honest empty OS fields */ }
      let vendorSample = null;
      try { vendorSample = vendor ? await vendor.sample() : null; } catch { vendorSample = null; }
      if (generation !== telemetryGeneration) return false;
      emitTelemetry({
        t: Date.now(),
        deviceId: null,
        sessionGeneration: generation,
        ...extra,
        // M17c: vendor readouts win over the WMI sys-stats on overlap.
        ...(vendorSample ?? {}),
        // M17g: used-RAM composition stays in the fast lane; vendor used-VRAM
        // remains the preferred value where it exists.
        memoryUsedBytes: vendorSample?.gpuMemUsedBytes ?? extra.memoryUsedBytes,
      });
      return true;
    };
    const timer = setInterval(() => { void sampleNow(); }, pollMs);
    // M17g: the slow lane starts WITH the no-device session (the
    // background PowerShell cadence refreshing the remaining OS-counter
    // fields; stopped with stopAllTelemetry - the idempotent start in the
    // adapter keeps one timer across the telemetry sessions).
    try { await sysStats.startSlowLane?.(undefined, generation); } catch { /* best effort */ }
    if (await cleanupStaleTelemetryStartup({ generation, timer, vendor })) return;
    telemetry.set(NULL_DEVICE_KEY, {
      stop: async () => {
        clearInterval(timer);
        try { await vendor?.close?.(); } catch { /* best effort */ }
      },
      sampleNow,
    });
    // Null/focus-unavailable mode has the same immediate-first-sample
    // contract as a device lane. This keeps CPU/OS telemetry populated on
    // startup even when no safe GPU target can be focused.
    await sampleNow();
  };

  const startTelemetryLane = async (deviceId) => {
    if (telemetry.has(deviceId)) return;
    const generation = ++telemetryGeneration;
    // M17e (round-2 N4, the overlay polling-rate slider): the telemetry
    // DEFAULT is 400 ms (M17g: the stock polling rate FLIPS 500 -> 400;
    // telemetry-service.js) - the overlay's tick reads
    // pollMs ONCE at svc.start() (a change RESTARTS the push with the new
    // interval - the live-restart reaction in profiles-settings-save).
    let pollMs = OVERLAY_POLL_MS_DEFAULT;
    try {
      const s = await store.loadSettings();
      pollMs = clampOverlayPollMs(s.overlayPollMs);
    } catch {
      // a store read failure keeps the default cadence
    }
    if (generation !== telemetryGeneration) return;
    // M30: an OS-only inventory row keeps the same selected-device telemetry
    // contract, but its measurements come from the matching vendor adapter
    // (or the selected OS stats only).  It must never enter the IGCL service
    // with another adapter's numeric id.
    const target = await backend.getDeviceTarget?.(deviceId);
    if (generation !== telemetryGeneration) return;
    const telemetryAliases = Array.isArray(target?.deviceKeys) ? [...target.deviceKeys] : null;
    try { await sysStats.setTarget?.(target); } catch { /* stale OS target degrades to null fields */ }
    if (generation !== telemetryGeneration) return;
    if (target?.synthetic || target?.backendKind === 'os') {
      let vendor = null;
      try {
          vendor = typeof vendorTelemetry.startFor === 'function'
          ? await vendorTelemetry.startFor(target, { owner: 'telemetry' })
          : await vendorTelemetry.start();
      } catch { vendor = null; }
      if (await cleanupStaleTelemetryStartup({ generation, vendor })) return;
      const sampleNow = async () => {
        let extra = {};
        // Synthetic/vendor lanes are physical secondary targets. The generic
        // fast lane is focused-adapter state, so it must never fill a missing
        // per-target sample and misattribute VRAM/utilization to this lane.
        try { extra = await sysStats.sampleForTarget?.(target) ?? {}; } catch { /* honest empty target fields */ }
        let sample = null;
        try { sample = vendor?.sample ? await vendor.sample() : null; } catch { sample = null; }
        if (generation !== telemetryGeneration) return false;
        emitTelemetry({
          t: Date.now(),
          deviceId,
          deviceKey: target?.deviceKey ?? null,
          deviceKeys: telemetryAliases,
          sessionGeneration: generation,
          ...extra,
          ...(sample ?? {}),
        });
        return true;
      };
      const timer = setInterval(() => { void sampleNow(); }, pollMs);
      try { await sysStats.startSlowLane?.(undefined, generation); } catch { /* best effort */ }
      if (await cleanupStaleTelemetryStartup({ generation, timer, vendor })) return;
      telemetry.set(deviceId, {
        stop: async () => {
          clearInterval(timer);
          try { await vendor?.close?.(); } catch { /* best effort */ }
        },
        sampleNow,
      });
      // Synthetic AMD/NVIDIA rows use the vendor/OS lane rather than
      // TelemetryService, so explicitly publish the first composed sample
      // before the first timer tick as well.
      await sampleNow();
      return;
    }
    const svc = new TelemetryService(backend, deviceId, { pollMs, immediate: true });
    let lastTelemetryError = null;
    // M4-D2: the pushed sample carries the system stats (CPU util/freq/
    // temp + GPU memory) - the injected sysStats adapter. M17g: the push
    // handler samples the FAST lane per tick (ms-fast native reads:
    // GetSystemTimes / MSR / GlobalMemoryStatusEx - NEVER the slow
    // PowerShell query) and emits IMMEDIATELY with the merged cache
    // (fast ?? slow); the slow CIM query runs DECOUPLED on the adapter's
    // own background timer (startSlowLane below), refreshing the
    // remaining OS-counter fields (gpuMemUsedBytes/gpuUtilPct/cpuFreqMhz
    // + the MSR-less WMI temp/power fallbacks) into the shared cache.
    // The mock adapter returns fixed values; the real adapter degrades
    // per-field to null (honest '-' in the UI).
    // M4-I (D2 - merge precedence): the DEVICE telemetry wins -
    // { ...extra, ...sample } - DEFENSIVE: today the field sets share zero
    // keys (N1), but an injected colliding field must never let an OS
    // stat overwrite the device's IGCL reading (igcl-wins; pinned by the
    // injected-collision unit test).
    // M14/M17g: the sample CARRIES the used-RAM-bytes field from the
    // sysStats adapter's FAST lane (the M17g move - the emit-site
    // composition is replaced by the fast-lane field; the fixture's
    // memoryUsedBytes 12400000000 rides the push while the null-returning
    // mock detector stays unrun).
    svc.onSample(async (sample) => {
      let extra = {};
      try {
        extra = await sysStats.sampleFast();
      } catch {
        // a stats failure must never break the telemetry push
        extra = {};
      }
      if (generation !== telemetryGeneration) return;
      emitTelemetry({
        deviceId,
        deviceKey: target?.deviceKey ?? null,
        deviceKeys: telemetryAliases,
        sessionGeneration: generation,
        ...extra,
        ...sample,
      });
    });
    // B390/Battlemage driver builds can report the Intel power-telemetry
    // surface as unavailable even though the OS performance counters remain
    // usable. Keep the selected device alive and publish those honest OS
    // fields instead of suppressing the entire Monitoring stream until the
    // next successful IGCL read. IGCL fields (temperature/clock/power) are
    // never fabricated by this fallback and remain '-' when unsupported.
    svc.onPollError((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail !== lastTelemetryError) {
        lastTelemetryError = detail;
        console.warn(`[telemetry] Intel device ${deviceId} poll degraded: ${detail}`);
      }
      void (async () => {
        let extra = {};
        try { extra = await sysStats.sampleFast(); } catch { /* honest empty OS fields */ }
        if (generation !== telemetryGeneration) return;
        emitTelemetry({
          t: Date.now(),
          deviceId,
          deviceKey: target?.deviceKey ?? null,
          deviceKeys: telemetryAliases,
          sessionGeneration: generation,
          ...extra,
        });
      })();
    });
    await svc.start();
    if (generation !== telemetryGeneration) {

      await svc.stop();
      return;
    }
    // M17g: the slow lane starts WITH the telemetry session (the
    // background PowerShell cadence; the idempotent start in the adapter
    // keeps ONE timer across the sessions - stopped with stopAllTelemetry).
    try { await sysStats.startSlowLane?.(undefined, generation); } catch { /* best effort */ }
    if (await cleanupStaleTelemetryStartup({ generation, service: svc })) return;
    telemetry.set(deviceId, svc);
  };

  // The Advanced Overlay can be opened before the main renderer has reached
  // its normal telemetry-start call (for example while the app is hidden in
  // the tray). Keep that panel self-sufficient by allowing its snapshot read
  // to bring up the same selected-device lane. Serialize this with the main
  // renderer's start so two concurrent callers can never create competing
  // TelemetryService instances for one device.
  const telemetryStarting = new Map();
  const startTelemetry = async (deviceId, refreshExisting = true) => {
    const active = telemetry.get(deviceId);
    if (active) {
      // M151: a secondary renderer may have started this shared lane before
      // the main dashboard installed its listener. Re-sample an existing
      // native lane so the current consumer receives a fresh composed sample;
      // synthetic/vendor lanes have no sampleNow seam and keep their timer.
      if (refreshExisting) {
        try { await active.sampleNow?.(); } catch { /* retain the live lane */ }
      }
      return;
    }
    const pending = telemetryStarting.get(deviceId);
    if (pending) return pending;
    const start = startTelemetryLane(deviceId);
    telemetryStarting.set(deviceId, start);
    try {
      await start;
    } finally {
      if (telemetryStarting.get(deviceId) === start) telemetryStarting.delete(deviceId);
    }
  };
  /**
   * Start the Basic Overlay's secondary GPU lanes. These lanes deliberately
   * do not replace the main selected-device service or the shared OS-stats
   * target; they publish only the secondary adapter's own readings.
   */
  const startOverlayTelemetry = async (deviceIds) => {
    const generation = ++overlayTelemetryGeneration;
    await stopOverlayTelemetry();
    let pollMs = OVERLAY_POLL_MS_DEFAULT;
    try {
      const s = await store.loadSettings();
      pollMs = clampOverlayPollMs(s.overlayPollMs);
    } catch { /* retain the default cadence */ }
    if (generation !== overlayTelemetryGeneration) return;
    const devices = await backend.listDevices();
    if (generation !== overlayTelemetryGeneration) return;
    const wanted = [...new Set(deviceIds)]
      .filter((id) => Number.isInteger(id) && id >= 0)
      .filter((id) => devices.some((device) => device.id === id));
    for (const deviceId of wanted) {
      if (generation !== overlayTelemetryGeneration) return;
      const device = devices.find((entry) => entry.id === deviceId);
      const target = await backend.getDeviceTarget?.(deviceId);
      if (generation !== overlayTelemetryGeneration) return;
      // Register every physical target before choosing its telemetry source.
      // Synthetic AMD/NVIDIA lanes use vendor samples for vendor-specific
      // fields, but generic VRAM/utilization counters still come from the
      // per-adapter sysStats record.
      try { sysStats.registerTarget?.(target); } catch { /* per-target stats registration is best effort */ }
      if (target?.synthetic || target?.backendKind === 'os') {
        // renderer's vendor singleton must never be rebound by this lane.
        const vendorLane = typeof vendorTelemetryFactory === 'function'
          ? vendorTelemetryFactory({ sysinfo, target })
          : createVendorTelemetry({ sysinfo });
        let vendor = null;
        try {
          vendor = typeof vendorLane.startFor === 'function'
            ? await vendorLane.startFor(target, { owner: 'overlay' })
            : await vendorLane.start();
        } catch { vendor = null; }
        if (generation !== overlayTelemetryGeneration) {
          try { await vendorLane.close?.(); } catch { /* stale lane */ }
          return;
        }
        const timer = setInterval(() => {
          void (async () => {
            if (generation !== overlayTelemetryGeneration) return;
            let extra = {};
            try {
              extra = await sysStats.sampleForTarget?.(target) ?? {};
            } catch { /* honest empty OS fields */ }
            let sample = null;
            try { sample = vendor?.sample ? await vendor.sample() : null; } catch { sample = null; }
            if (generation !== overlayTelemetryGeneration) return;
            const merged = {
              ...extra,
              ...(sample ?? {}),
              // A vendor adapter may report null for generic fields even
              // though the OS stats lane has a valid per-target value.
              gpuMemUsedBytes: sample?.gpuMemUsedBytes ?? extra.gpuMemUsedBytes ?? null,
              gpuUtilPct: sample?.gpuUtilPct ?? extra.gpuUtilPct ?? null,
            };
            emitTelemetry({
              t: Date.now(),
              deviceId,
              deviceKey: target?.deviceKey ?? device?.deviceKey ?? null,
              deviceKeys: Array.isArray(target?.deviceKeys)
                ? [...target.deviceKeys]
                : Array.isArray(device?.deviceKeys) ? [...device.deviceKeys] : null,
              sessionGeneration: telemetryGeneration,
              ...merged,
            });
          })();
        }, pollMs);
        overlayTelemetry.set(deviceId, {
          stop: async () => {
            clearInterval(timer);
            try { await vendorLane.close?.(); } catch { /* best effort */ }
          },
        });
        continue;
      }
      const svc = new TelemetryService(backend, deviceId, { pollMs, immediate: true });
      svc.onSample(async (sample) => {
        if (generation !== overlayTelemetryGeneration) return;
        let extra = {};
        try {
          extra = await sysStats.sampleForTarget?.(target) ?? {};
        } catch { /* honest empty OS fields */ }
        if (generation !== overlayTelemetryGeneration) return;
        emitTelemetry({
          deviceId,
          deviceKey: target?.deviceKey ?? device?.deviceKey ?? null,
          deviceKeys: Array.isArray(target?.deviceKeys)
            ? [...target.deviceKeys]
            : Array.isArray(device?.deviceKeys) ? [...device.deviceKeys] : null,
          sessionGeneration: telemetryGeneration,
          ...extra,
          ...sample,
        });
      });
      try {
        if (generation !== overlayTelemetryGeneration) {
          await svc.stop();
          return;
        }
        await svc.start();
        if (generation !== overlayTelemetryGeneration) {
          await svc.stop();
          return;
        }
        overlayTelemetry.set(deviceId, svc);
      } catch {
        try { await svc.stop(); } catch { /* best effort */ }
      }
    }
    // Secondary lanes can be the first telemetry consumer (for example when
    // the main window is still loading). Their registrations must seed the
    // shared per-target slow caches themselves; the main lane remains free to
    // share this idempotent timer later.
    if (wanted.length > 0) {
      try { await sysStats.startSlowLane?.(undefined, telemetryGeneration); } catch { /* best effort */ }
    }
  };

  // M152: the main process assigns the holder after IPC registration. If a
  // renderer starts a lane during that window, its initial optional calls are
  // intentionally empty; once the adapter lands, reconcile the live session
  // without creating a second timer or orphaning the existing service.
  reconcileSysStatsReady = async () => {
    if (telemetry.size === 0 && overlayTelemetry.size === 0 && telemetryStarting.size === 0) return;
    try { await sysStats.startSlowLane?.(undefined, telemetryGeneration); } catch { /* best effort */ }
    await Promise.all([...telemetry.values()].map(async (service) => {
      try { await service.sampleNow?.(); } catch { /* retain the live lane */ }
    }));
  };

  const stopAllTelemetry = async () => {
    telemetryGeneration += 1;
    overlayTelemetryGeneration += 1;
    // A startup can still be waiting on inventory/sysinfo when teardown
    // arrives. Do not let a later snapshot read join that invalidated promise
    // instead of starting a fresh lane for the current panel.
    telemetryStarting.clear();
    for (const svc of telemetry.values()) {
      try { await svc.stop(); } catch { /* best effort */ }
    }
    telemetry.clear();
    latestTelemetry.clear();
    // M17g: the slow lane is tied to the telemetry session lifecycle -
    // stopped with stopAllTelemetry (the background PowerShell cadence
    // must not outlive the last push; an in-flight query finishes on its
    // own - no new tick starts).
    try { await sysStats.stopSlowLane?.(); } catch { /* best effort */ }
    await stopOverlayTelemetry();
  };

  const hasWaiverNotSet = (result) => Object.values(result?.perControl ?? {})
    .some((p) => p?.errorCode === 'waiver-not-set');

  /**
   * M4-D (PERMANENT acceptance): ONE apply attempt through the
   * elevation-aware worker or the in-process routed core, with the silent
   * waiver re-set + single retry. When the driver answers waiver-not-set
   * AND the persisted acceptance is true (settings.json - the user's
   * permanent consent), MAIN silently re-sets the driver waiver
   * (runner.waiverAccept / backend.setWaiverAccepted - elevated) and
   * retries the apply ONCE; the FIRST attempt is never surfaced as a
   * failure to the renderer. Exactly one retry - a second waiver-not-set
   * returns the retry's envelope as-is. An unaccepted store keeps the
   * current behavior (no auto re-set - the renderer's dialog flow handles
   * it). persistWaiverLost is REMOVED: the store never flips to false on a
   * driver refusal.
   * M4O: a profileApply carries the flag through BOTH branches - the
   * worker request gains it (the worker skips the stock gate) and the
   * in-process executeApply clamps against the driver's TRUE limits.
   * M17c (round-3 N1): EVERY attempt records into the session
   * refused-ceiling store via the backend's SHARED recording helper
   * (recordApplyRefusals - never a throw). The attempted settings source:
   * the WORKER envelope's `refused` map (the worker's own clamped values -
   * the parent's pre-delegation clamp may differ from the worker's caps),
   * else the parent's clamped `settings` (the in-process path - the value
   * executeApply actually attempted). GATE refusals (ocModeRefused /
   * extendedUnavailable - config refusals, NOT driver ceiling refusals)
   * never record - the store must only degrade on a driver 'out-of-range'.
   * @param {{ deviceId: number, settings: object, caps: object, ocMode: 'stock'|'advanced', profileApply?: boolean }} req
  */
  const runApply = async ({ deviceId, settings, caps, ocMode, profileApply }) => {
    const normalizeApply = (out) => withCapabilityFlags(out);
    // Resolve the durable target first. The capability payload is a renderer
    // snapshot and older sessions can carry a null deviceKey even though the
    // authoritative inventory row is keyed. Extended writes must use that
    // row key or the bundled runtime will reject the request before writing.
    const target = typeof backend.getTarget === 'function'
      ? await backend.getTarget(deviceId)
      : typeof backend.getDeviceTarget === 'function'
        ? await backend.getDeviceTarget(deviceId, null)
        : typeof backend.listDevices === 'function'
          ? (await backend.listDevices()).find((device) => device.id === deviceId) ?? null
          : null;
    const deviceKey = typeof target?.deviceKey === 'string'
      ? target.deviceKey
      : typeof caps?.deviceKey === 'string'
        ? caps.deviceKey
        : null;
    const physicalTarget = physicalTargetOf(target);
    const recordRefusals = (result) => {
      if (!result || typeof result !== 'object') return;
      if (result.ocModeRefused === true || result.extendedUnavailable === true) return;
      try {
        // M17c (step-4 N2): record the CLAMPED attempted values - the value
        // the driver actually saw. The apply-settings handler already
        // pre-clamps `settings` with the same ranges, so this re-clamp is
        // idempotent for today's callers; it makes the recording contract
        // self-contained (a direct runApply caller can never record a
        // pre-clamp value whose snap lands above the caps max and no-ops in
        // mergeIntoRanges).
        const attempted = result.refused
          ?? clampSettings(settings, profileApply === true ? extendedRangesFor(caps) : caps.ranges);
        backend.recordApplyRefusals?.(deviceId, result, attempted);
      } catch {
        // a store failure must never break the apply flow
      }
    };
    const attempt = async (waiverAccepted) => {
      if (applyRunner?.needsWorker?.()) {
        // M17c (step-4 N6): the parent-resolved limits-key rides the worker
        // request - the worker's gate thresholds must match the parent's
        // (the worker's own caps decode the subsystem only; on a laptop the
        // parent's portable branch could differ).
        const out = await applyRunner.apply({
          deviceId,
          deviceKey,
          physicalTarget,
          settings,
          waiverAccepted,
          ocMode,
          profileApply,
          limitsKey: { pciDeviceId: caps.pciDeviceId ?? null, aibVendor: caps.aibVendor ?? null, aibModel: caps.aibModel ?? null },
        });
        // S2 G2 mirror: when the driver lost the waiver, the worker's
        // per-control results carry waiver-not-set. Clear the parent-side
        // in-memory flag so getCapabilities reports unaccepted and the
        // dialog re-shows - the wedge (stale-true parent flag with failing
        // applies) must never happen.
        const normalized = normalizeApply(out);
        if (hasWaiverNotSet(normalized.result)) await backend.restoreWaiverState(deviceId, false);
        recordRefusals(normalized.result);
        return normalized;
      }
      const normalized = normalizeApply(await executeApply({ backend, oldIgcl, deviceId, deviceKey, physicalTarget, settings, opts: { profileApply }, ocMode, sysmanPowerLimits }));
      recordRefusals(normalized.result);
      return normalized;
    };
    const first = await attempt(caps.waiverAccepted === true);
    if (!hasWaiverNotSet(first.result)) {
      return normalizeApply({ result: first.result, state: first.state, ...(first.extendedUnavailable === true ? { extendedUnavailable: true } : {}), ...(first.extendedUnavailablePartial === true ? { extendedUnavailablePartial: true } : {}) });
    }
    let persistedAccepted = false;
    try {
      persistedAccepted = (await store.loadSettings()).waiverAccepted === true;
    } catch {
      // degraded: no auto re-set (an unreadable store must not silently
      // accept anything).
    }
    if (!persistedAccepted) {
      // Unaccepted store: current behavior - the renderer's dialog flow
      // re-prompts and re-applies.
      return normalizeApply({ result: first.result, state: first.state, ...(first.extendedUnavailable === true ? { extendedUnavailable: true } : {}), ...(first.extendedUnavailablePartial === true ? { extendedUnavailablePartial: true } : {}) });
    }
    // M4-D: silent re-set + retry ONCE. A declined re-set (UAC) surfaces the
    // FIRST attempt's envelope - never a fake success, never a crash.
    try {
      if (applyRunner?.needsWorker?.()) {
          await applyRunner.waiverAccept(deviceId, deviceKey, physicalTarget);
        await backend.restoreWaiverState(deviceId, true);
      } else {
        await backend.setWaiverAccepted(deviceId);
      }
    } catch {
      return normalizeApply({ result: first.result, state: first.state, ...(first.extendedUnavailable === true ? { extendedUnavailable: true } : {}), ...(first.extendedUnavailablePartial === true ? { extendedUnavailablePartial: true } : {}) });
    }
    const retry = await attempt(true);
    return normalizeApply({ result: retry.result, state: retry.state, ...(retry.extendedUnavailable === true ? { extendedUnavailable: true } : {}), ...(retry.extendedUnavailablePartial === true ? { extendedUnavailablePartial: true } : {}) });
  };

  // Resolve a session id to its durable physical adapter identity. The
  // unified inventory exposes getDeviceTarget, while direct test/mock
  // backends may only expose getTarget or listDevices. Keeping this fallback
  // here makes per-GPU tuning mode persistence work through the same IPC
  // contract in every backend shape.
  const modeTarget = async (deviceId) => {
    if (typeof backend.getDeviceTarget === 'function') {
      return backend.getDeviceTarget(deviceId);
    }
    if (typeof backend.getTarget === 'function') {
      return backend.getTarget(deviceId);
    }
    if (typeof backend.listDevices === 'function') {
      return (await backend.listDevices()).find((device) => device.id === deviceId) ?? null;
    }
    return null;
  };

  // Resolve a Game Profile assignment by stable physical identity. The
  // legacy null-key assignment may still follow the persisted focused GPU;
  // keyed assignments must never fall back to an ordinal device id.
  const gameProfileTarget = async (deviceKey, persisted) => {
    let devices = [];
    try { devices = typeof backend.listDevices === 'function' ? await backend.listDevices() : []; } catch { devices = []; }
    if (typeof deviceKey === 'string' && deviceKey.length > 0) {
      const matches = devices.filter((device) => device?.synthetic !== true
        && device?.backendKind !== 'os'
        && device?.identityAmbiguous !== true
        && (device?.deviceKey === deviceKey || (Array.isArray(device?.deviceKeys) && device.deviceKeys.includes(deviceKey))));
      return matches.length === 1 ? matches[0] : null;
    }
    if (Number.isInteger(persisted?.deviceId) && persisted.deviceId >= 0) {
      const match = devices.find((device) => device?.id === persisted.deviceId
        && device?.synthetic !== true && device?.backendKind !== 'os' && device?.identityAmbiguous !== true);
      return match ?? null;
    }
    return null;
  };

  const handlers = {
    'health': async () => collectHealth(backend),

      'list-devices': async () => {
        try {
          return await backend.listDevices();
        } catch (err) {
          // 1.0.1 no-Intel round: a backend INIT failure (the IGCL runtime
          // DLL not found / ctlInit / enumeration failed - health then
          // reports igclLoaded false) degrades to an EMPTY list instead of
          // throwing: the renderer distinguishes "no Intel GPU" (health
          // igclLoaded false + devices empty) and continues booting in the
          // no-device mode. The catch keeps the throw for any NON-init IPC
          // failure (the smoke/apply flows keep their own init handling).
          if (typeof backend.initError !== 'undefined' && backend.initError !== null) {
            return [];
          }
          throw err;
        }
      },

      // M4-F: the persisted GPU selection. device-get is the boot read (the
      // persisted id may be null - absent field -> the devices[0] fallback
      // resolves at boot); device-set is the ONLY writer (like oc-mode-set -
      // profiles-settings-save carries it read-modify-write but never
      // chooses it). The id is validated as a non-negative integer; the
      // enumerated-set check is the boot resolution's job (self-heal).
      // M29: device-get/set carry both the session id and durable hardware key.
      'device-get': async (...args) => {
        assertNoPayload(args, 'device-get');
        const s = await store.loadSettings();
        return { deviceId: s.deviceId, deviceKey: s.deviceKey ?? null };
      },
      // M151: the persisted selection remains a user-owned setting. This
      // separate read-only channel supplies the automatic startup preference
      // so a stale/legacy iGPU selection can never force the focused view away
      // from a live discrete adapter. It is intentionally not persisted.
      'device-preferred-get': async (...args) => {
        assertNoPayload(args, 'device-preferred-get');
        try {
          return await preferredSelection();
        } catch {
          return { deviceId: null, deviceKey: null };
        }
      },
      // Main-renderer selection generations survive renderer reloads in this
      // process. The renderer handshakes before its first selection push so
      // its local counter cannot restart below the main-owned latest value.
      'device-selection-generation-get': async (...args) => {
        assertNoPayload(args, 'device-selection-generation-get');
        return { generation: latestMainSelectionGeneration };
      },

      'device-set': async (selection) => {
        const isObject = typeof selection === 'object' && selection !== null;
        const deviceId = isObject ? selection.deviceId : selection;
        assertValidDeviceId(deviceId);
        const cur = await store.loadSettings();
        const devices = await backend.listDevices();
        const device = devices.find((d) => d.id === deviceId);
        if (!device) throw new Error(`unknown device id ${deviceId}`);
        if (device.identityAmbiguous === true) {
          throw new Error(`cannot persist selection for device id ${deviceId}: physical identity is ambiguous`);
        }
        const deviceKey = device.deviceKey ?? deviceHardwareKey(device);
        if (isObject && selection.deviceKey !== undefined
          && (typeof selection.deviceKey !== 'string' || selection.deviceKey !== deviceKey)) {
          throw new Error(`device key mismatch for device id ${deviceId}`);
        }
        await store.saveSettings({ ...cur, deviceId, deviceKey });
        return { deviceId, deviceKey };
      },
      // M31: panel selection requests are explicit and durable-key based.
      // This channel only wakes the main renderer; it never owns telemetry,
      // persistence, or a second device-set flow.
      'device-selection-request': async (deviceKey) => {
        if (typeof deviceKey !== 'string' || deviceKey.length === 0) {
          throw new Error('deviceKey must be a non-empty string');
        }
        emit('device-selection:request', { deviceKey });
        return { accepted: true };
      },

      'device-selection-push': async (payload) => {
        if (!payload || typeof payload !== 'object') throw new Error('selection payload must be an object');
        assertValidDeviceId(payload.deviceId);
        if (payload.deviceKey !== null && typeof payload.deviceKey !== 'string') {
          throw new Error('selection deviceKey must be a string or null');
        }
        if (payload.selectionGeneration !== undefined
          && (!Number.isInteger(payload.selectionGeneration) || payload.selectionGeneration < 0)) {
          throw new Error('selectionGeneration must be a non-negative integer');
        }
        if (!payload.caps || typeof payload.caps !== 'object' || !payload.state || typeof payload.state !== 'object') {
          throw new Error('selection payload must carry caps and state');
        }
        const generation = payload.selectionGeneration;
        if (generation !== undefined) {
          if (generation <= latestMainSelectionGeneration) {
            throw new Error('stale device selection payload');
          }
          // Reserve the generation before the async store read so concurrent
          // pushes cannot both pass the initial comparison.
          latestMainSelectionGeneration = generation;
        }
        // The main renderer saves the durable selection before publishing its
        // atomic pair. A late response from an older switch must not fan out
        // after a newer persisted selection has won. Sequenced main-renderer
        // pushes remain valid when deviceSet could not persist the session
        // switch; the monotonic generation is the in-memory source of truth.
        const persisted = await store.loadSettings();
        if (generation !== undefined && generation !== latestMainSelectionGeneration) {
          throw new Error('stale device selection payload');
        }
        if (generation === undefined && persisted.deviceId !== null
          && (persisted.deviceId !== payload.deviceId
            || (persisted.deviceKey ?? null) !== (payload.deviceKey ?? null))) {
          throw new Error('stale device selection payload');
        }
        emit('device-selection:updated', {
          deviceId: payload.deviceId,
          deviceKey: payload.deviceKey ?? null,
          caps: payload.caps,
          state: payload.state,
        });
        return { accepted: true };
      },

      'get-capabilities': async (deviceId) => {
        assertValidDeviceId(deviceId);
        return backend.getCapabilities(deviceId);
      },

      'get-current-settings': async (deviceId) => {
        assertValidDeviceId(deviceId);
        return backend.getCurrentSettings(deviceId);
      },

      // M17f: the sysman PL2 read-out source - { sustainedW, burstW, peakW }
      // when the sysman layer answers, null when it is absent (the honest
      // '-' on the power-limit card). Never throws (the consumer is
      // defensive; the renderer degrades to the '-' line on null/error).
      // M17f (step-4 N2): DEVICE-SCOPED - the deviceId threads into the
      // read (the domain is per-device; the mock keys on it - the
      // multi-device read-out mismatch fix).
      'power-limits:read': async (deviceId) => {
        assertValidDeviceId(deviceId);
        const target = await backend.getDeviceTarget?.(deviceId);
        if (target?.synthetic || target?.backendKind === 'os') return null;
        if (!sysmanPowerLimits) return null;
        try {
          // M163: Sysman is a separate process/context, so carry the same
          // physical proof used by elevated applies. A session id alone is
          // not enough when the helper enumerates multiple adapters.
          return await sysmanPowerLimits.readLimits(deviceId, physicalTargetOf(target));
        } catch {
          return null;
        }
      },

      // M8 (the Graphics tab): the 3D-feature surface. 'graphics:get' is the
      // page's load read (assertValidDeviceId-guarded - the renderer NEVER
      // calls it with a null deviceId: the no-Intel page guard renders
      // 'No GPU available.' first, plan-review S3). The backend never
      // throws - the all-false/null state is the honest degrade.
      'graphics:get': async (deviceId) => {
        assertValidDeviceId(deviceId);
        return backend.getGraphicsSettings(deviceId);
      },

      // M8: the DEDICATED graphics apply path (plan-review S1 - the OC
      // machinery cannot carry a graphics payload: sanitizeSettings throws
      // on unknown controls, the worker op whitelist was OC-only, the
      // waiver semantics do not transfer). No ocModeRefusal, no
      // extendedUnavailableRefusal, no OC waiver retry - 3D features have
      // no OC waiver. The elevation-aware runner mirrors apply(): the
      // in-process branch + the elevated 'graphics-apply' worker branch
      // (the elevation toast pattern stays on the page). The response
      // envelope is { ok, perControl, graphicsState } with the FRESH
      // getGraphicsSettings read-back for the page's per-control refresh.
      'graphics:apply': async (deviceId, payload) => {
        assertValidDeviceId(deviceId);
        const target = await backend.getDeviceTarget?.(deviceId);
        // The FPS clamp range: the device's FRESH graphics state (the
        // driver-reported range; the 30-300-1-60 fallback inside the
        // validator when the read degrades).
        let range = null;
        try {
          range = (await backend.getGraphicsSettings(deviceId)).frameLimitRange;
        } catch {
          // degraded - the validator's fallback applies
        }
        const settings = sanitizeGraphicsSettings(payload, range);
        if (target?.synthetic || target?.backendKind === 'os') {
          const perControl = Object.fromEntries(Object.keys(settings).map((key) => [key, { ok: false, errorCode: 'unsupported', message: 'graphics features are not supported on this GPU' }]));
          return { ok: Object.keys(perControl).length === 0, perControl, graphicsState: await backend.getGraphicsSettings(deviceId) };
        }
        if (applyRunner?.needsWorker?.()) {
          const out = await applyRunner.graphicsApply({ deviceId, deviceKey: target?.deviceKey ?? null, physicalTarget: physicalTargetOf(target), settings });
          return { ok: out.ok === true, perControl: out.perControl ?? {}, graphicsState: out.graphicsState ?? null };
        }
        const out = await backend.setGraphicsSettings(deviceId, settings);
        let graphicsState = null;
        try { graphicsState = await backend.getGraphicsSettings(deviceId); } catch { /* degraded */ }
        return { ok: out.ok, perControl: out.perControl, graphicsState };
      },

      // M10b (the Graphics "Display" view): the display-output surface.
      // 'display:get' is the page's Display-view load read
      // (assertValidDeviceId-guarded like graphics:get - the renderer NEVER
      // calls it with a null deviceId: the no-Intel page guard renders
      // 'No GPU available.' first). The backend never throws - the
      // { displays: [] } shape is the honest no-controls degrade.
      'display:get': async (deviceId) => {
        assertValidDeviceId(deviceId);
        return backend.getDisplaySettings(deviceId);
      },

      // M10b: the DEDICATED display apply path (plan-review S1, the
      // graphics-apply twin - the OC machinery cannot carry a display
      // payload: display settings have no OC waiver and no OC-mode gate).
      // No ocModeRefusal, no extendedUnavailableRefusal, no OC waiver
      // retry. The elevation-aware runner mirrors graphics:apply: the
      // in-process branch + the elevated 'display-apply' worker branch (the
      // elevation toast pattern stays on the page). The response envelope
      // is { ok, perControl, displayState } with the FRESH
      // getDisplaySettings read-back for the page's per-control refresh.
      'display:apply': async (deviceId, request) => {
        assertValidDeviceId(deviceId);
        if (typeof request !== 'object' || request === null || Array.isArray(request)) {
          throw new Error('display apply request must be a plain object');
        }
        if (typeof request.deviceKey !== 'string' || request.deviceKey.length === 0
          || typeof request.displayKey !== 'string' || request.displayKey.length === 0) {
          throw new Error('display apply request requires stable deviceKey and displayKey');
        }
        const target = await backend.getDeviceTarget?.(deviceId);
        if (!target || target.deviceKey !== request.deviceKey) {
          throw new Error('stale display target: the selected graphics adapter changed; refresh Display and try again');
        }
        const settings = sanitizeDisplaySettings(request.patch);
        if (target.synthetic || target.backendKind === 'os') {
          const perControl = Object.fromEntries(Object.keys(settings).map((key) => [key, { ok: false, errorCode: 'unsupported', message: 'display settings are not supported on this GPU' }]));
          return { ok: Object.keys(perControl).length === 0, perControl, displayState: await backend.getDisplaySettings(deviceId) };
        }
        const applyRequest = { deviceId, deviceKey: request.deviceKey, displayKey: request.displayKey, physicalTarget: physicalTargetOf(target), settings };
        if (applyRunner) {
          const out = await applyRunner.displayApply(applyRequest);
          return { ok: out.ok === true, perControl: out.perControl ?? {}, displayState: out.displayState ?? null };
        }
        await backend.assertDeviceTarget?.(deviceId, request.deviceKey, physicalTargetOf(target));
        const out = await backend.setDisplaySettings(deviceId, { deviceKey: request.deviceKey, displayKey: request.displayKey, patch: settings });
        let displayState = null;
        try { displayState = await backend.getDisplaySettings(deviceId); } catch { /* degraded */ }
        return { ok: out.ok, perControl: out.perControl, displayState };
      },

      'apply-settings': async (deviceId, payload, opts) => {
        assertValidDeviceId(deviceId);
        const settings = sanitizeSettings(payload);
        // M3-C-E: the OC-mode gate runs BEFORE every clamp - an explicit
        // pre-clamp REFUSAL, never a clamp. Stock mode refuses anything
        // beyond the standard limits (252 W / 90 C) with the mode message;
        // advanced mode refuses only above the sysman-primary ceiling
        // (375 W on the A770 / 115 C - never clamps, so an above-ceiling
        // request is reported honestly).
        // A config-refusal is NOT a hardware failure: it must never trigger
        // the reset-to-defaults fallback anywhere downstream.
        // M4-E: the gate is unit-aware - it receives the capability RANGES
        // so percent-unit devices (Battlemage) are never mode-refused (the
        // units probe is a device property, identical on both sides of the
        // worker boundary - never the extendedRanges flag). The caps read
        // is a capability probe, not a write; the gate still refuses before
        // any clamp.
        // M4O: a profileApply (the Profiles-page Apply button) SKIPS the
        // STOCK gate - the mode is the interactive slider gate ONLY, a
        // saved profile applies as saved (uniform with the boot/tray/
        // --apply-profile paths). The CEILING refusal STAYS: a hand-edited
        // above-ceiling profile (above the M21 sysman-primary 375 W on the
        // A770) must refuse with OC_CEILING_REFUSAL_MSG, never a
        // silent clamp. The flagless interactive path is UNCHANGED - the
        // mode still gates the slider applies.
        const caps = await backend.getCapabilities(deviceId);
        const persisted = await store.loadSettings();
        // Capabilities are the authoritative mode for this physical GPU.
        // The persisted scalar/map fallback is only for older backends that
        // do not yet echo ocMode in their capability payload.
        const targetKey = typeof caps?.deviceKey === 'string' ? caps.deviceKey : null;
        const keyedMode = targetKey && persisted.ocModes && typeof persisted.ocModes === 'object'
          ? persisted.ocModes[targetKey]
          : null;
        // A keyed persisted mode wins for a physical adapter. With no keyed
        // override, retain the legacy scalar setting as the session default;
        // the capability echo is only a fallback for older callers that do
        // not persist settings. This keeps direct IPC tests and old settings
        // files compatible while preventing one GPU's keyed mode from
        // leaking into another GPU's apply gate.
        const ocMode = keyedMode === 'advanced' || keyedMode === 'stock'
          ? keyedMode
          : persisted.ocMode === 'advanced' || persisted.ocMode === 'stock'
            ? persisted.ocMode
            : caps?.ocMode;
        if (caps?.overclockingSupported === false) {
          const perControl = Object.fromEntries(Object.keys(settings).map((key) => [key, { ok: false, errorCode: 'unsupported', message: 'overclocking is not supported on this GPU' }]));
          return { result: { ok: Object.keys(perControl).length === 0, perControl }, state: await backend.getCurrentSettings(deviceId) };
        }
        // M17c: the device-scoped gate thresholds - the caps carry the
        // device identity (pciDeviceId/aibVendor/aibModel), which the
        // ocModeRefusal limits-key resolves from the pure device-limits
        // table (the listed rows' ceilings for listed cards, the default
        // row for unlisted - never caps.ranges).
        // M17d (Run D): the GATE MODE is the mode the whole apply runs
        // under - the same value ocModeRefusal receives and the same value
        // threaded into splitByRuntime (via runApply -> executeApply -> the
        // V1-call pin): the persisted ocMode for interactive applies,
        // OC_MODE_ADVANCED for profile applies (a saved profile applies as
        // saved - the advanced-gated split routes its W/C values through
        // the V1 runtime, per the 2026-08-12 A750 probe verdict).
        const gateMode = opts?.profileApply === true ? OC_MODE_ADVANCED : ocMode;
        const refusal = ocModeRefusal(gateMode, settings, caps.ranges, caps);
        if (refusal) {
          // M3-C review F2: the refusal envelope carries the FRESH device
          // state (getCurrentSettings is cheap - the refusal never touched
          // the GPU). A null state would be stored by the renderer
          // unconditionally and null out its device state (the OC page
          // renders 'Loading device capabilities…' forever and the dirty
          // helpers throw on it). Degraded to null only if the read itself
          // fails - the renderer's non-null guard covers that too.
          let state = null;
          try { state = await backend.getCurrentSettings(deviceId); } catch { /* degraded */ }
          return { result: { ok: false, perControl: refusalPerControl(refusal) }, state, ocModeRefused: true };
        }
        // M3-C step-5 F1: advanced mode + a NOT-capable bundled 2023 runtime
        // (the future-driver degradation EXTENDED_UNAVAILABLE_MSG exists
        // for) must refuse extended values BEFORE any clamp - clamping
        // 300 W to 252 W and reporting ok:true would be a false success
        // claim. Keyed on caps.extendedRanges (the capability probe is
        // identical on both sides of the worker boundary), never on the
        // mode. Same refusal envelope as the mode gate: fresh state, never
        // a defaults-restore downstream.
        // M4O: a profileApply keys the probe on the RUNTIME capability
        // (oldIgcl.isCapable) instead of the mode-gated caps flag - the
        // ipc-core ctx has oldIgcl; a genuinely not-capable driver (the
        // default createNullOldIgcl) still refuses honestly.
        // M46/F1: when the product is unelevated, the elevated worker owns
        // the bundled 2023-runtime capability decision. The parent can
        // legitimately report Advanced W/C ranges from its installed/runtime
        // surface while its own ctlInit probe fails with ERROR_KMD_CALL; do
        // not reject or clamp the request before it reaches that worker.
        // An in-process path still keys the refusal on its actual OldIgcl
        // capability, preserving the honest no-runtime failure.
        const delegatedAdvancedRuntime = gateMode === OC_MODE_ADVANCED
          && applyRunner?.needsWorker?.() === true;
        let unavailableCaps = caps;
        if (delegatedAdvancedRuntime) {
          unavailableCaps = {
            ...caps,
            extendedRanges: true,
            // M48: the elevated worker recomputes both controls; the parent
            // must not pre-refuse on its unelevated probe.
            extendedControls: { powerLimitW: true, tempLimitC: true },
          };
        } else if (oldIgcl?.isCapable) {
          unavailableCaps = { ...caps, extendedRanges: await oldIgcl.isCapable() };
        }
        let unavailable = extendedUnavailableRefusal(settings, unavailableCaps, sysmanPowerLimits);
        if (!unavailable && opts?.profileApply === true && unavailableCaps.extendedRanges !== true) {
          // M17d (Run D - the V1-call pin): a profile apply is advanced-
          // gated, so its W/C values route through the bundled 2023 runtime
          // (V1) REGARDLESS of value. The sole M47 exception is a W-unit
          // powerLimitW above EXTENDED_PL_MAX_W with an available Sysman
          // primary seam; in-range W/C values retain the refusal.
          const wc = wcUnitControls(settings, caps.ranges)
            .filter((key) => key !== 'powerLimitW'
              || !isSysmanPrimaryPowerRequest(settings, caps.ranges, sysmanPowerLimits));
          if (wc.length > 0) unavailable = { controls: wc, message: EXTENDED_UNAVAILABLE_MSG };
        }
        if (unavailable && Object.keys(settings).every((key) => unavailable.controls.includes(key))) {
          let state = null;
          try { state = await backend.getCurrentSettings(deviceId); } catch { /* degraded */ }
          return { result: { ok: false, perControl: extendedUnavailablePerControl(unavailable.controls) }, state, extendedUnavailable: true };
        }
        // M4O (NEW-1): the pre-clamp must NOT silently clamp a profileApply
        // - a profile applies against the driver's TRUE limits
        // (extendedRangesFor), never the mode-gated caps.ranges (stock max
        // 252 would silently reduce a saved 300 W profile). M47 applies the
        // same true-range clamp to a Sysman-primary >315 W request, whose
        // seam owns the value when OldIgcl is unavailable.
        const clampRanges = opts?.profileApply === true || delegatedAdvancedRuntime
          || isSysmanPrimaryPowerRequest(settings, caps.ranges, sysmanPowerLimits)
          ? extendedRangesFor(caps)
          : caps.ranges;
        // M50: reject a learned/native temperature ceiling before this
        // parent clamps settings for either the in-process or elevated path.
        const capabilityRefusal = tempCapabilityRefusal(settings, clampRanges);
        const capabilityControls = capabilityRefusal?.controls ?? [];
        const capabilityPerControl = capabilityRefusal
          ? tempCapabilityPerControl(capabilityRefusal)
          : {};
        const routedSettings = capabilityControls.length > 0
          ? Object.fromEntries(Object.entries(settings).filter(([key]) => !capabilityControls.includes(key)))
          : settings;
        if (capabilityRefusal && Object.keys(routedSettings).length === 0) {
          let state = null;
          try { state = await backend.getCurrentSettings(deviceId); } catch { /* degraded */ }
          return {
            result: { ok: false, perControl: capabilityPerControl },
            state,
            capabilityCeilingRefused: true,
          };
        }
        const clamped = clampSettings(routedSettings, clampRanges);
        // M2C-C elevation gate: a non-elevated app delegates the apply to
        // the elevated self-worker (one UAC prompt); the elevated app (and
        // mock mode, where applyRunner is null) applies in-process through
        // the routed core (DriverStore runtime <=252 W / <=90 C, bundled
        // 2023 runtime above). The worker runs the SAME core + gate (the
        // request file carries ocMode - the worker's own caps always report
        // extendedRanges, so a caps-keyed gate there would silently clamp).
        // M4-D (PERMANENT acceptance): runApply silently re-sets the
        // driver waiver + retries ONCE when the driver answers waiver-not-set
        // while the persisted acceptance is true (the consent stands - never
        // a dialog, never a dead-end, never a persisted false).
        const out = await runApply({ deviceId, settings: clamped, caps, ocMode: gateMode, profileApply: opts?.profileApply === true });
        if (!capabilityRefusal) return out;
        const perControl = { ...out.result.perControl, ...capabilityPerControl };
        return withCapabilityFlags({
          ...out,
          result: {
            ...out.result,
            ok: Object.values(perControl).every((per) => per?.ok === true),
            perControl,
          },
        });
      },

      'reset-to-defaults': async (deviceId) => {
        assertValidDeviceId(deviceId);
        // M2C-C: the reset write needs elevation like any other OC write
        // (0-value writes are refused even elevated - reset runs
        // ctlOverclockResetToDefault, which works elevated only). The
        // non-elevated app delegates to the elevated self-worker.
        let state = null;
        const target = await backend.getDeviceTarget?.(deviceId);
        if (applyRunner?.needsWorker?.()) {
          const out = await applyRunner.reset(deviceId, target?.deviceKey ?? null, physicalTargetOf(target));
          state = out.state;
        } else {
          await backend.resetToDefaults(deviceId);
          state = await backend.getCurrentSettings(deviceId);
        }
        // No success claims without verification (plan §5): confirm the
        // supported OC controls moved to their capability defaults
        // (tolerance-aware). ctlOverclockResetToDefault does NOT touch fan
        // config, so only OC controls are checked. gpuLock is expected
        // unlocked (0,0) after a reset.
        const caps = await backend.getCapabilities(deviceId);
        const mismatched = [];
        for (const [key, range] of Object.entries(caps.ranges)) {
          const value = state?.[key];
          if (value !== null && value !== undefined && range && !nearlyEqual(value, range.default, RESET_VERIFY_EPS)) {
            mismatched.push(`${key}: read-back ${value} != default ${range.default}`);
          }
        }
        if (caps.controls.gpuLock && state?.gpuLock
          && (!nearlyEqual(state.gpuLock.voltageV, 0, RESET_VERIFY_EPS) || !nearlyEqual(state.gpuLock.freqMhz, 0, RESET_VERIFY_EPS))) {
          mismatched.push(`gpuLock: read-back ${state.gpuLock.voltageV}V/${state.gpuLock.freqMhz}MHz != unlocked (0,0)`);
        }
        if (mismatched.length > 0) {
          throw new Error(`reset-to-defaults verification failed: ${mismatched.join('; ')}`);
        }
        return { state };
      },

      'waiver-get': async (deviceId) => {
        assertValidDeviceId(deviceId);
        const caps = await backend.getCapabilities(deviceId);
        return { accepted: caps.waiverAccepted === true };
      },

      'waiver-accept': async (deviceId) => {
        assertValidDeviceId(deviceId);
        // Product path: explicit user acceptance ONLY. Never auto-accept.
        // M2C-C: the driver-side waiver write needs elevation like any other
        // OC write - the non-elevated app delegates to the elevated worker.
        if (applyRunner?.needsWorker?.()) {
          const target = await backend.getDeviceTarget?.(deviceId);
          await applyRunner.waiverAccept(deviceId, target?.deviceKey ?? null, physicalTargetOf(target));
          // S2: the worker accepted on the driver - mirror the acceptance
          // into the parent's in-memory flag so getCapabilities/waiver-get
          // reflect it for the whole session (the worker's state is not
          // visible across the boundary).
          await backend.restoreWaiverState(deviceId, true);
        } else {
          await backend.setWaiverAccepted(deviceId);
        }
        const settings = await store.loadSettings();
        await store.saveSettings({ ...settings, waiverAccepted: true });
        return { accepted: true };
      },

      'telemetry-start': async (deviceId) => {
        // 1.0.1 no-Intel round: telemetry-start(null) starts the no-device
        // mode (the sentinel-keyed sys-stats-only timer). A real device id
        // is still validated as a non-negative integer.
        if (deviceId === null || deviceId === undefined) {
          await startNullTelemetry();
          return;
        }
        assertValidDeviceId(deviceId);
        await startTelemetry(deviceId);
      },
      'telemetry-latest': async (deviceId) => {
        assertValidDeviceId(deviceId);
        // A panel opened before the main renderer's boot telemetry call must
        // still receive live data. This is idempotent and shares the same
        // in-flight startup promise as telemetry-start.
        // A snapshot read must not perturb the cadence or advance the mock/
        // native counter; it only starts a missing lane.
        await startTelemetry(deviceId, false);
        return latestTelemetry.get(deviceId) ?? null;
      },
      'overlay-telemetry-start': async (deviceIds) => {
        if (!Array.isArray(deviceIds)) throw new Error('overlay telemetry device list must be an array');
        await startOverlayTelemetry(deviceIds);
      },

      'telemetry-stop': async (deviceId) => {
        // 1.0.1 no-Intel round (m3): telemetry-stop(null) is the SYMMETRIC
        // stop for the no-device mode (sentinel key in the shared Map).
        if (deviceId === null || deviceId === undefined) {
          const svc = telemetry.get(NULL_DEVICE_KEY);
          // Invalidate an in-flight start even before it installs its
          // service in the map; otherwise a rollback can be followed by a
          // stale timer appearing after this stop returns.
          telemetryGeneration += 1;
          telemetryStarting.delete(NULL_DEVICE_KEY);
          latestTelemetry.delete(NULL_DEVICE_KEY);
          if (svc) {
            await svc.stop();
            telemetry.delete(NULL_DEVICE_KEY);
          }
          return;
        }
        assertValidDeviceId(deviceId);
        const svc = telemetry.get(deviceId);
        // The map can still be empty while target/provider/service startup
        // awaits. Stop must invalidate that pending start unconditionally.
        telemetryGeneration += 1;
        telemetryStarting.delete(deviceId);
        latestTelemetry.delete(deviceId);
        if (svc) {
          await svc.stop();
          telemetry.delete(deviceId);
        }
      },

      // M17d (round-1 S2): the vendor-lane STATIC-INFO read - the no-Intel
      // dashboard VRAM/Compute rows' source ({ vramBytes, computeCores } -
      // the NVML total + core count; honest nulls when the lane has no
      // source: no vendor adapter, an absent DLL, or a vendor without the
      // field - ADL). Starts the lane if needed (the same lazy resolution
      // the no-device telemetry hook uses - idempotent). Never throws: a
      // lane failure degrades to the honest nulls (the renderer then falls
      // back to the OS controller bytes / the '-' rows).
      'vendor-info:get': async (...args) => {
        if (args.length > 1) throw new Error('vendor-info:get takes at most a device id');
        try {
      const target = args.length === 1 && Number.isInteger(args[0])
            ? await backend.getDeviceTarget?.(args[0]) : null;
          const lane = target && typeof vendorTelemetry.startFor === 'function'
            ? await vendorTelemetry.startFor(target, { owner: 'static' })
            : await vendorTelemetry.start();
          if (!lane || typeof lane.deviceInfo !== 'function') {
            return { vramBytes: null, computeCores: null };
          }
          const info = await lane.deviceInfo();
          const vramBytes = typeof info?.vramBytes === 'number' && Number.isFinite(info.vramBytes) && info.vramBytes > 0
            ? Math.floor(info.vramBytes)
            : null;
          const computeCores = typeof info?.computeCores === 'number' && Number.isFinite(info.computeCores) && info.computeCores > 0
            ? Math.floor(info.computeCores)
            : null;
          return { vramBytes, computeCores };
        } catch {
          return { vramBytes: null, computeCores: null };
        }
      },

      // M3-A: the registry-hacks catalog (Tweaks page) - read-side only.
      // Real reg.exe queries in the product path (no elevation); the default
      // adapter is the MOCK so tests and --ui-verify never touch the real
      // registry. The M3-B apply channel is 'registry-apply'.
      'registry-catalog': async (...args) => {
        assertNoPayload(args, 'registry-catalog');
        return catalogAdapter.get();
      },

      // M3-B: apply one catalog action ELEVATED (Enable/Disable/Revert per
      // the entry's apply descriptor). The default adapter is the MOCK
      // (never spawns PowerShell, never elevates); ipc.js injects the real
      // adapter in the product path - every write then runs in an elevated
      // PowerShell (one UAC per action) and the result reports per-step
      // truth (including the UAC-cancel and partial-failure paths - no
      // silent partial state, no auto-revert). The entry's apply descriptor
      // is resolved HERE from the catalog: the renderer supplies only
      // entryId + action, never raw commands.
      'registry-apply': async (entryId, action) => {
        if (typeof entryId !== 'string' || entryId.length === 0) {
          throw new Error('registry-apply: entryId must be a non-empty string');
        }
        if (typeof action !== 'string' || !['enable', 'disable', 'revert'].includes(action)) {
          throw new Error('registry-apply: action must be one of enable, disable, revert');
        }
        return registryApplyAdapter.apply(entryId, action);
      },

      // Run-key (start-with-windows / apply-at-boot) state (M2b/M4-D2).
      // startup.set writes the HKCU Run value ONLY on an explicit user
      // click (unelevated reg.exe - zero UAC); the default adapter is the
      // MOCK so tests/ui-verify never touch the real registry.
      'startup-get': async (...args) => {
        assertNoPayload(args, 'startup-get');
        const raw = await startup.get();
        // M4-D2 derivation: ONE Run value serves both toggles. The value
        // existing means the app starts at logon; the toggle semantics are
        // composed HERE from the persisted settings:
        //   startWithWindows = value exists AND the Settings toggle is on;
        //   applyOnBoot = value exists AND the profile's start-at-boot is
        //   on AND an active profile exists.
        const settings = await store.loadSettings();
        let hasActiveProfile = Boolean(settings.activeProfileId);
        try {
          hasActiveProfile = activeProfileEntries(settings, await store.loadProfiles()).length > 0 || hasActiveProfile;
        } catch {
          // Keep the legacy scalar fallback if the profile list is temporarily
          // unavailable; the persisted intent remains authoritative.
        }
        return {
          startWithWindows: raw.valueExists === true && settings.startWithWindows === true,
          applyOnBoot: raw.valueExists === true
            && settings.ocOnBoot === true
            && hasActiveProfile,
        };
      },

      // M4-D2: enable/disable the HKCU Run value (the bare "<exe>" - no
      // profile id, no tasks, no elevation). Validates the boolean and
      // returns the composed state (same derivation as startup-get).
      'startup-set': async (enabled) => {
        if (typeof enabled !== 'boolean') throw new Error('startup-set: enabled must be a boolean');
        await startup.set(enabled);
        return handlers['startup-get']();
      },

      // M4-D: the system-info read (CPU card + the VRAM enrichment
      // source). Read-side only, cached at boot in the product path; the
      // default adapter is the MOCK fixture (tests/--ui-verify never spawn
      // PowerShell).
      'sysinfo:get': async (...args) => {
        assertNoPayload(args, 'sysinfo:get');
        // Defensive: the adapter shape ({ get }) is the contract, but the
        // raw result would be a silent-empty CPU card if ever passed
        // directly (the M4-D product bug) - accept both.
        return typeof sysinfo.get === 'function' ? sysinfo.get() : sysinfo;
      },

      // M4-D: the integrated-title-bar window controls. No payload;
      // the ops are injected (default no-ops in tests; main.js wires the
      // real BrowserWindow in the product path, counting probes in
      // --ui-verify mode).
      'window-minimize': async (...args) => {
        assertNoPayload(args, 'window-minimize');
        await windowOps.minimize();
      },

      'window-maximize-toggle': async (...args) => {
        assertNoPayload(args, 'window-maximize-toggle');
        await windowOps.maximizeToggle();
      },

      'window-close': async (...args) => {
        assertNoPayload(args, 'window-close');
        await windowOps.close();
      },

      // M5/M6: the software-overlay ops (the windowOps pattern). 'overlay:
      // get-state' is the Overlay page's every-render read (the
      // hotkeyRegistered flag + the geometry); 'overlay:toggle' is the
      // SHORTCUT flip (M7b fix 5): gated on the persisted master
      // overlayEnabled - while the master is OFF it does NOTHING (no
      // window change, no persist), and when ON it flips the SESSION
      // visibility only, NEVER writing overlayEnabled (the Overlay-page
      // toggle is its only writer - the hotkey and the toggle work
      // independently). No payload; the ops are injected (the DEFAULT is
      // the honest "no overlay window" state; main.js wires the real
      // overlay handle).
      'overlay:get-state': async (...args) => {
        assertNoPayload(args, 'overlay:get-state');
        return overlayOps.getState();
      },

      'overlay:toggle': async (...args) => {
        assertNoPayload(args, 'overlay:toggle');
        await overlayOps.toggle();
        return overlayOps.getState();
      },
      'overlay-resize': async (deviceCount) => {
        if (!Number.isInteger(deviceCount) || deviceCount < 1 || deviceCount > 32) {
          throw new Error('overlay device count must be an integer from 1 to 32');
        }
        await overlayOps.resize(deviceCount);
      },

      // M23: the ADVANCED-overlay ops (the overlayOps pattern, new names -
      // the AMD-Adrenaline-style interactive side panel). 'advanced-overlay:
      // get-state' is the panel's every-render read (exists/visible/bounds +
      // the persisted enabled master + the live hotkeyRegistered flag from
      // the SECOND hotkey seam); 'advanced-overlay:toggle' is the SHORTCUT
      // flip (M7b fix-5 semantics): gated on the persisted
      // advancedOverlayEnabled master - while the master is OFF it does
      // NOTHING (no window change, no persist), and when ON it flips the
      // SESSION visibility only, NEVER writing advancedOverlayEnabled (the
      // Overlay-view toggle is its only writer). No payload; the ops are
      // injected (the DEFAULT is the honest "no panel" state; main.js wires
      // the real panel handle).
      'advanced-overlay:get-state': async (...args) => {
        assertNoPayload(args, 'advanced-overlay:get-state');
        return advancedOverlayOps.getState();
      },

      'advanced-overlay:toggle': async (...args) => {
        assertNoPayload(args, 'advanced-overlay:toggle');
        await advancedOverlayOps.toggle();
        return advancedOverlayOps.getState();
      },

      // M23: the panel's custom CLOSE button - a DEDICATED channel (the
      // main window is never closed by the panel - reusing 'window-close'
      // would let the panel drive windowOps.close() which targets the main
      // window). The op is injected (the DEFAULT is a no-op); main.js wires
      // it to the panel handle's session hide.
      'advanced-overlay:close': async (...args) => {
        assertNoPayload(args, 'advanced-overlay:close');
        await advancedOverlayClose();
      },

      // M4-H (D1): the sidebar GitHub link - open a URL in the default
      // browser via the injected shell.openExternal op. STRICT validation
      // (S3): new URL() + protocol https: + hostname github.com + the
      // pathname is exactly '/YamsSE/Arc-Power' or a '/YamsSE/Arc-Power/'
      // prefix - NEVER a string-prefix check (host-boundary tricks like
      // 'github.com.evil.example' or 'github.com@evil.example' must fail).
      'open-external': async (url) => {
        if (typeof url !== 'string' || url.length === 0) {
          throw new Error('open-external: url must be a non-empty string');
        }
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error('open-external: url is not a valid URL');
        }
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
          throw new Error('open-external: only https://github.com links are allowed');
        }
        if (parsed.pathname !== '/YamsSE/Arc-Power' && !parsed.pathname.startsWith('/YamsSE/Arc-Power/')) {
          throw new Error('open-external: only the Arc-Power repository is allowed');
        }
        await openExternal(parsed.toString());
      },

      // Display-driver registry date (M2b-B, read-only): never touches the
      // registry in mock mode - the default adapter returns the fixture.
      'driver-info': async (...args) => {
        assertNoPayload(args, 'driver-info');
        return driverInfo.get();
      },

      // App version for the header line (M2C-B B3, read-only): the product
      // path injects electron's app.getVersion(); the default reads
      // package.json so tests and --ui-verify never need electron.
      'app-version': async (...args) => {
        assertNoPayload(args, 'app-version');
        return { version: appVersion };
      },

      // M4-E (build kind, read-only): which distribution this process is -
      // 'installed' (packaged, no PORTABLE_EXECUTABLE_DIR - the elevated
      // ArcPowerBootApply task story), 'portable' (the portable wrapper set
      // PORTABLE_EXECUTABLE_DIR - unelevated in-app applies), or 'dev' (the
      // dev tree / tests). The Settings card's start-with-Windows hint text
      // differentiates by it. The default is 'dev' (tests); main.js injects
      // the real kind.
      'app:build-info': async (...args) => {
        assertNoPayload(args, 'app:build-info');
        return { kind: buildKind };
      },

      // M52: clear the dedicated disposable user-data cache and restart.
      // The lifecycle operation is injected by main.js; tests and default
      // handlers use its honest no-op result.
      'app:clear-cache-restart': async (...args) => {
        assertNoPayload(args, 'app:clear-cache-restart');
        const out = await appLifecycle.clearCacheAndRestart();
        if (!out || typeof out.ok !== 'boolean' || typeof out.restarting !== 'boolean') {
          throw new Error('app lifecycle returned an invalid clear-cache result');
        }
        return out;
      },

      // M4N (A.1): the window-path boot apply's outcome record ({ ok,
      // detail, at } or null when no boot apply ran this session). M16:
      // the record no longer drives the dashboard OC Status row (the row
      // derives its stock-state verdict from the driver read-back) - it is
      // kept for the boot fetch contract + the boot-apply ui-verify pins.
      // The mock-only mock:run-boot-apply channel deliberately does NOT
      // update this record - the mid-session probe leaves the OC row as the
      // boot outcome (documented decision).
      'boot-apply-outcome': async (...args) => {
        assertNoPayload(args, 'boot-apply-outcome');
        return bootApplyOutcome();
      },

      // M2C-C elevation state (read-only, cached koffi probe - no spawn):
      // `elevated` = this process runs as administrator; `workerApply` =
      // applies go through the elevated self-worker (product path, not
      // elevated). The renderer uses `workerApply` to show the
      // "Administrator approval is needed" toast before the UAC prompt.
      'app-elevated': async (...args) => {
        assertNoPayload(args, 'app-elevated');
        const elevated = isElevated();
        return { elevated, workerApply: applyRunner?.needsWorker?.() === true };
      },

      // M25: auto-update check (GitHub Releases). The build kind selects the
      // matching release asset, so portable builds never download an
      // installer (and installed builds never download a portable wrapper).
      'update:check': async (...args) => {
        if (args.length > 1 || (args.length === 1 && (typeof args[0] !== 'object' || args[0] === null || Array.isArray(args[0])))) {
          throw new Error('update:check intent must be startup or manual');
        }
        const intent = args[0]?.intent ?? 'startup';
        if (intent !== 'startup' && intent !== 'manual') throw new Error('update:check intent must be startup or manual');
        if (buildKind !== 'installed' && buildKind !== 'portable') return { available: false };
        if (typeof startupUpdateCheck === 'function') {
          return startupUpdateCheck({ buildKind, intent });
        }
        const { checkForUpdates } = await import('./auto-update.js');
        return checkForUpdates({ buildKind });
      },

      // M25: download an update asset to temp. Returns { ok, path } or
      // throws on failure. The renderer sends the assetUrl from the check.
      'update:download': async (assetUrl) => {
        if (typeof assetUrl !== 'string' || !assetUrl.startsWith('https://')) {
          throw new Error('invalid asset URL');
        }
        const { downloadUpdate } = await import('./auto-update.js');
        const filePath = await downloadUpdate(assetUrl, undefined, buildKind);
        return { ok: true, path: filePath };
      },

      // M25: install a downloaded update and quit the app. The main process
      // validates the temp path again before either launching the installer
      // or starting the portable replacement handoff.
      'update:install': async (filePath) => {
        if (typeof filePath !== 'string') throw new Error('missing file path');
        const { installUpdate } = await import('./auto-update.js');
        await installUpdate(filePath, { buildKind, portableWrapperPath });
      },

      // FPS via DXGI GetFrameStatistics (M4-D2 - replaced PresentMon). The
      // default adapter is the mock (always null); the product path injects
      // the real DXGI adapter, which itself degrades to null when DXGI is
      // unavailable. Never throws.
      // M17c: the ETW/PresentMon lane is the PREFERRED source when it has a
      // fresh sample (the game's per-frame present rate - RTSS-class
      // accuracy); the DXGI adapter remains the fallback tier (the
      // desktop-presentation rate) when the lane is idle/absent. The lane
      // is null in mock/tests - the composition is a no-op there and every
      // existing pin stays green.
      // M10a: the sample COMPOSES the foreground-window Graphics-API badge -
      // the fpsAdapter's own api field (the RID_MOCK_API=1 mock fixture)
      // wins, otherwise the injected detector answers (the DEFAULT is the
      // null-returning detector - the determinism seam; the real koffi
      // probe runs only in the product path).
      'fps-poll': async (deviceId) => {
        assertValidDeviceId(deviceId);
        const laneSample = presentMonLane ? await presentMonLane.poll(deviceId) : null;
        const sample = laneSample !== null ? laneSample : await fpsAdapter.poll(deviceId);
        if (sample === null || typeof sample !== 'object') return null;
        // M10a: the foreground-window Graphics-API badge composition. The
        // sample's own api field wins, otherwise the injected detector
        // answers (the DEFAULT is the null-returning detector - the
        // determinism seam; the real koffi probe runs only in the product
        // path).
        // M17d (Run C, item 1e): the PresentMon-service CLASS corroboration
        // - when the module scan yields null, the lane's presentRuntime
        // class ('dxgi'/'d3d9'/'other' - the PM_GRAPHICS_RUNTIME class the
        // overlay labels DXGI/D3D9/Other) answers through the SAME api
        // field; a module-scan verdict ALWAYS wins (the fine grain stays
        // module-derived). Absent presentRuntime -> null (the overlay row
        // stays empty - the honest degrade).
        const api = sample.api ?? (await foregroundApi.detect()) ?? (typeof sample.presentRuntime === 'string' ? sample.presentRuntime : null);
        return { ...sample, api };
      },

      // M4-D2: Monitoring "Log to file" - append one log line for a
      // full telemetry sample (the pushed sample incl. the 4 system-stats
      // fields + fps). The payload is validated as a plain object; the
      // writer appends the line (header on first open) and never throws -
      // IO errors are reported as { ok: false, error } so the renderer can
      // show an honest note instead of a crash.
      'monitor-log-append': async (sample) => {
        if (typeof sample !== 'object' || sample === null || Array.isArray(sample)) {
          throw new Error('monitor-log-append: sample must be a plain object');
        }
        return monitorLog.append(sample);
      },

      // M99: Recording remains a narrow main-owned surface. Renderer input
      // is only a normalized settings patch or an opaque clip id; paths and
      // child-process arguments are resolved here.
      'recording-settings-get': async (...args) => {
        assertNoPayload(args, 'recording-settings-get');
        return recordingStore?.settings?.() ?? normalizeRecordingSettings({});
      },
      'recording-settings-save': async (patch) => {
        const nextPatch = recordingPatch(patch);
        if (nextPatch.location) fs.mkdirSync(nextPatch.location, { recursive: true });
        const settings = recordingStore?.saveSettings ? await recordingStore.saveSettings(nextPatch) : normalizeRecordingSettings(nextPatch);
        const hotkeys = await refreshRecordingHotkeys() ?? getRecordingHotkeyState();
        return { settings, hotkeys };
      },
      'recording-runtime-probe': async (...args) => {
        assertNoPayload(args, 'recording-runtime-probe');
        if (!recordingEngine?.probe) return { available: false, running: false, mode: null, startedAt: null, error: 'Bundled ascent-obs runtime is unavailable', encoders: [], audioInputs: [], audioOutputs: [], hotkeys: getRecordingHotkeyState() };
        return { ...(await recordingEngine.probe()), hotkeys: getRecordingHotkeyState() };
      },
      'recording-status': async (...args) => {
        assertNoPayload(args, 'recording-status');
        return { ...(recordingEngine?.getState?.() ?? { available: false, running: false, mode: null, startedAt: null, error: 'Bundled ascent-obs runtime is unavailable', encoders: [], audioInputs: [], audioOutputs: [] }), hotkeys: getRecordingHotkeyState() };
      },
      'recording-start': async (...args) => {
        assertNoPayload(args, 'recording-start');
        if (!recordingEngine?.startRecording || !recordingStore) throw new Error('Recording engine is not available');
        const settings = await recordingStore.settings();
        const location = recordingAbsolutePath(settings.location, 'location');
        fs.mkdirSync(location, { recursive: true });
        const outputPath = collisionSafeRecordingPath(location, 'recording', { exists: (candidate) => fs.existsSync(candidate) });
        const state = await recordingEngine.startRecording({ ...settings, outputPath });
        return { state, outputPath: path.basename(outputPath) };
      },
      'recording-stop': async (...args) => {
        if (args.length > 1 || (args.length === 1 && args[0] !== undefined && args[0] !== null && args[0] !== 'video' && args[0] !== 'replay')) throw new Error('recording-stop: mode must be video or replay');
        if (!recordingEngine?.stop) throw new Error('Recording engine is not available');
        return recordingEngine.stop(args[0] ?? null);
      },
      'recording-replay-start': async (...args) => {
        assertNoPayload(args, 'recording-replay-start');
        if (!recordingEngine?.startReplay || !recordingStore) throw new Error('Recording engine is not available');
        const settings = await recordingStore.settings();
        const location = recordingAbsolutePath(settings.location, 'location');
        fs.mkdirSync(location, { recursive: true });
        // Replay mode keeps only the rolling buffer. It must not receive a
        // normal file-output path, otherwise stopping the buffer can create a
        // full-session recording alongside the intended clips.
        const state = await recordingEngine.startReplay({ ...settings });
        return { state, outputPath: null };
      },
      'recording-clip-save': async (payload = {}) => {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('recording-clip-save: payload must be an object');
        if (!recordingEngine?.saveReplayClip || !recordingStore) throw new Error('Recording engine is not available');
        const settings = await recordingStore.settings();
        const location = recordingAbsolutePath(settings.location, 'location');
        const requestedDurationMs = Number(payload.headDurationMs);
        const configuredDurationMs = Number(settings.replayLengthSec) * 1000;
        const headDurationMs = Number.isFinite(requestedDurationMs) && requestedDurationMs > 0
          ? Math.min(3600000, Math.round(requestedDurationMs))
          : configuredDurationMs;
        fs.mkdirSync(location, { recursive: true });
        const outputPath = collisionSafeRecordingPath(location, 'clip', { exists: (candidate) => fs.existsSync(candidate) });
        const response = await recordingEngine.saveReplayClip({ path: outputPath, headDuration: headDurationMs, thumbnailFolder: location });
        return { response, outputPath: path.basename(outputPath) };
      },
      'recording-clips-list': async (...args) => {
        assertNoPayload(args, 'recording-clips-list');
        if (!recordingStore) return [];
        const clips = recordingStore.scanClips ? await recordingStore.scanClips() : await recordingStore.listClips();
        return clips.map((clip) => {
          const thumbnailUrl = mediaThumbnailUrl(clip?.id);
          return thumbnailUrl ? { ...clip, thumbnailUrl } : clip;
        });
      },
      'recording-storage-info': async (...args) => {
        assertNoPayload(args, 'recording-storage-info');
        if (!recordingStore) return { location: '', freeBytes: null, totalBytes: null };
        const settings = await recordingStore.settings();
        const location = recordingAbsolutePath(settings.location, 'location');
        return { location, ...recordingStorageSnapshot(location) };
      },
      'recording-capture-targets': async (...args) => {
        if (args.length > 1 || (args.length === 1 && typeof args[0] !== 'boolean')) throw new Error('recording-capture-targets: refresh must be boolean');
        return recordingCaptureTargets ? recordingCaptureTargets(args[0] === true) : { displays: [], windows: [] };
      },
      'recording-processes-list': async (...args) => {
        assertNoPayload(args, 'recording-processes-list');
        return recordingProcessList ? recordingProcessList() : listWindowsRecordingProcesses();
      },
      'recording-choose-folder': async (...args) => {
        assertNoPayload(args, 'recording-choose-folder');
        const selected = await chooseRecordingDirectory();
        if (!selected) return { canceled: true, settings: await recordingStore.settings() };
        const location = recordingAbsolutePath(selected, 'location');
        fs.mkdirSync(location, { recursive: true });
        // Folder browsing only stages the path in the renderer. Recording
        // settings use the same explicit Apply contract as Graphics/Tuning;
        // do not persist this selection before the user confirms it.
        return { canceled: false, location, settings: await recordingStore.settings() };
      },
      'recording-open-folder': async (...args) => {
        assertNoPayload(args, 'recording-open-folder');
        const settings = await recordingStore.settings();
        const location = recordingAbsolutePath(settings.location, 'location');
        fs.mkdirSync(location, { recursive: true });
        await openRecordingFolder(location);
        return { ok: true };
      },
      'recording-clip-url': async (id) => {
        if (!isOpaqueClipId(id)) throw new Error('recording-clip-url: invalid clip id');
        if (!recordingStore || !(await recordingStore.clipById(id))) throw new Error('recording-clip-url: clip not found');
        const url = mediaClipUrl(id);
        if (!url) throw new Error('recording-clip-url: invalid clip id');
        return url;
      },
      'recording-clip-delete': async (id) => {
        if (!isOpaqueClipId(id)) throw new Error('recording-clip-delete: invalid clip id');
        if (!recordingStore) return { ok: false, id, removed: false, reason: 'unavailable' };
        const clip = await recordingStore.clipById(id);
        if (!clip) return { ok: false, id, removed: false, reason: 'not-found' };
        const settings = await recordingStore.settings();
        const location = recordingAbsolutePath(settings.location, 'location');
        const filePath = resolveSafeRecordingPath(location, clip.relativePath, fs, { allowMissing: true });
        if (!filePath) return { ok: false, id, removed: false, reason: 'unsafe-path' };
        const handle = openSafeRecordingFile(filePath, fs);
        if (!handle) {
          try { fs.lstatSync(filePath); return { ok: false, id, removed: false, reason: 'unsafe-path' }; }
          catch (err) { return err?.code === 'ENOENT' ? { ok: false, id, removed: false, reason: 'not-found' } : { ok: false, id, removed: false, reason: 'delete-failed' }; }
        }
        try {
          const deletion = unlinkSafeRecordingFile(filePath, handle, fs);
          if (!deletion.ok) return { ok: false, id, removed: false, reason: deletion.reason };
        } finally {
          closeSafeRecordingFile(handle, fs);
        }
        const deleted = await recordingStore.deleteClip(id);
        return deleted
          ? { ok: true, id, removed: true, reason: null }
          : { ok: false, id, removed: false, reason: 'not-found' };
      },

      // Profiles (M2b-B). Every channel returns the full envelope
      // { profiles, settings } so the renderer can re-render from one
      // response. `settings` mirrors ProfileStore.loadSettings() (the
      // persisted ocOnBoot / activeProfileId - the Run-key truth lives in
      // startup-get). Payloads are validated before touching the store.
      'profiles-list': async (...args) => {
        assertNoPayload(args, 'profiles-list');
        return { profiles: await store.loadProfiles(), settings: await store.loadSettings() };
      },

      // M55a: scan is read-only. The adapter combines installed metadata and
      // running-process fallback; the catalog sidecar keeps non-running games.
      'games-scan': async (...args) => {
        assertNoPayload(args, 'games-scan');
        const result = await gameScan.scan();
        // The scan is the only path that labels rows as games. Keep the
        // conservative game gate here so Windows services and helper apps
        // never enter the persisted Game Profile catalog.
        const apps = normalizeScannedApps(result?.apps ?? [], [], { onlyGames: gameScan.onlyGames === true });
        let catalog = null;
        let sidecarError;
        try { catalog = await gameProfiles.syncCatalog(apps, { authoritative: true }); }
        catch (err) { sidecarError = `Game catalog unavailable: ${err instanceof Error ? err.message : String(err)}`; }
        return { ...(result ?? {}), apps, ...(catalog ? { catalog } : {}), ...(sidecarError ? { sidecarError } : {}) };
      },

      'game-catalog-list': async (...args) => {
        assertNoPayload(args, 'game-catalog-list');
        try { return await gameProfiles.loadCatalog(); }
        catch (err) { throw new Error(`game-catalog-list: ${err instanceof Error ? err.message : String(err)}`); }
      },

      'game-catalog-add': async (...args) => {
        assertNoPayload(args, 'game-catalog-add');
        const selected = await chooseGameExecutable();
        const pickedPath = typeof selected === 'string'
          ? selected
          : selected && selected.canceled !== true && Array.isArray(selected.filePaths)
            ? selected.filePaths[0]
            : null;
        if (pickedPath && !validateSafeGameCandidate(pickedPath, { requireExists: true })) {
          throw new Error('game-catalog-add: selected executable is not a safe existing game candidate');
        }
        const safePath = validateSafeGameCandidate(pickedPath, { requireExists: true });
        if (!safePath) return { canceled: true, ...(await gameProfiles.loadCatalog()) };
        const base = path.win32.basename(safePath);
        const entry = {
          exePath: safePath,
          processName: base,
          displayName: base.replace(/\.exe$/i, ''),
          source: 'manual',
        };
        try {
          const media = await gameArtwork(safePath);
          // Keep compatibility with injected/test providers that return the
          // legacy icon string, while the real provider supplies separate
          // cached banner and icon values.
          if (typeof media === 'string' && media.length > 0) entry.artwork = media;
          else if (media && typeof media === 'object') {
            if (typeof media.artwork === 'string' && media.artwork.length > 0) entry.artwork = media.artwork;
            if (typeof media.banner === 'string' && media.banner.length > 0) entry.banner = media.banner;
          }
        } catch { /* artwork is optional; the renderer uses its deterministic fallback */ }
        try { return { canceled: false, ...(await gameProfiles.addCatalogEntry(entry)) }; }
        catch (err) { throw new Error(`game-catalog-add: ${err instanceof Error ? err.message : String(err)}`); }
      },

      'game-profile-capabilities': async (...args) => {
        if (args.length > 2) throw new Error('game-profile-capabilities takes a device id and optional executable path');
        const [deviceId, exePath] = args;
        assertValidDeviceId(deviceId);
        const safeExePath = exePath === undefined || exePath === null ? undefined : canonicalExePath(exePath);
        if (exePath !== undefined && exePath !== null && !safeExePath) {
          throw new Error('game-profile-capabilities: exePath must be an absolute Windows executable path');
        }
        if (typeof backend.getGameProfileCapabilities !== 'function') {
          return { enduranceGaming: false, xeFg: false, xeFgOptions: [], reason: 'Game Profile driver capabilities are unavailable.', xeFgReason: 'Game Profile driver capabilities are unavailable.' };
        }
        return backend.getGameProfileCapabilities(deviceId, safeExePath);
      },

      'game-catalog-sync': async (payload) => {
        if (!Array.isArray(payload)) throw new Error('game-catalog-sync: payload must be an array');
        for (const row of payload) {
          if (!validateSafeGameCandidate(row?.exePath ?? row?.ExecutablePath)) {
            throw new Error('game-catalog-sync: executable is not a safe existing game candidate');
          }
        }
        return { catalog: await gameProfiles.syncCatalog(normalizeScannedApps(payload, [], { requireExists: true }), { authoritative: true }) };
      },

      'game-settings-save': async (payload) => serializeGameProfileMutation(async () => {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('game-settings-save: payload must be an object');
        if (Object.prototype.hasOwnProperty.call(payload, 'gpuProfiles')) throw new Error('game-settings-save: save one GPU assignment at a time');
        if (payload.deviceKey !== undefined && payload.deviceKey !== null
          && (typeof payload.deviceKey !== 'string' || payload.deviceKey.trim().length === 0 || payload.deviceKey.length > 256)) {
          throw new Error('game-settings-save: deviceKey must be a non-empty stable GPU key or null');
        }
        if (payload.deviceName !== undefined && payload.deviceName !== null
          && (typeof payload.deviceName !== 'string' || payload.deviceName.trim().length === 0 || payload.deviceName.length > 256)) {
          throw new Error('game-settings-save: deviceName must be a non-empty GPU name or null');
        }
        const clean = normalizeGameSettings(payload);
        if (!clean) throw new Error('game-settings-save: exePath must be an absolute Windows path');
        const safePath = validateSafeGameCandidate(clean.exePath);
        if (!safePath) throw new Error('game-settings-save: executable is not a safe existing game candidate');
        const catalog = await gameProfiles.loadCatalog();
        if (!catalog?.catalog?.some((entry) => entry.exePath === safePath)) {
          throw new Error('game-settings-save: executable is not present in the game catalog');
        }
        const targetKey = payload.deviceKey === undefined || payload.deviceKey === null ? null : payload.deviceKey.trim();
        const persisted = await store.loadSettings();
        const previous = catalog.settings?.find((item) => item.exePath === safePath) ?? null;
        const previousAssignment = previous?.gpuProfiles?.find((item) => (item.deviceKey ?? null) === targetKey) ?? null;
        const assignment = mergeGameGpuProfilePatch(previousAssignment, {
          ...payload,
          deviceKey: targetKey,
          graphics: clean.graphics,
        });
        const target = await gameProfileTarget(targetKey, persisted);
        const targetDeviceId = Number.isInteger(target?.id) ? target.id : null;
        if (assignment.tuningProfileId !== null) {
          const profiles = await store.loadProfiles();
          const selectedProfile = profiles.find((profile) => profile.id === assignment.tuningProfileId);
          if (!selectedProfile) {
            throw new Error('game-settings-save: tuning profile was not found');
          }
          const profileTargetsDevice = !selectedProfile.deviceKey
            || selectedProfile.deviceKey === targetKey
            || selectedProfile.deviceKey === target?.deviceKey
            || (Array.isArray(target?.deviceKeys) && target.deviceKeys.includes(selectedProfile.deviceKey));
          if (!profileTargetsDevice) {
            throw new Error('game-settings-save: tuning profile belongs to another GPU');
          }
        }
        let graphics = assignment.graphics;
        let xeFgRefusal = null;
        if (Object.prototype.hasOwnProperty.call(graphics, 'frameGenOverride')) {
          let capabilities = null;
          if (targetDeviceId !== null && typeof backend.getGameProfileCapabilities === 'function') {
            try { capabilities = await backend.getGameProfileCapabilities(targetDeviceId, safePath); } catch { /* fail closed below */ }
          }
          if (capabilities?.xeFg !== true) {
            const { frameGenOverride: _ignored, ...withoutXeFg } = graphics;
            graphics = withoutXeFg;
            if (assignment.enabled === true) {
              xeFgRefusal = {
                ok: false,
                errorCode: 'unsupported',
                message: capabilities?.xeFgReason ?? 'XeFG is unavailable for this executable.',
              };
            }
          }
        }
        // Never persist an XeFG override for an executable that the capability
        // gate did not prove eligible. This also cleans stale values from an
        // older sidecar when a profile is edited after the gate is tightened.
        const finalAssignment = normalizeGameGpuProfile({ ...assignment, graphics });
        const saved = await gameProfiles.saveSettings({
          ...previous,
          exePath: safePath,
          gpuProfiles: mergeGameGpuProfiles(previous?.gpuProfiles, [finalAssignment]),
        });
        let apply;
        if (targetDeviceId === null || typeof backend.setGameProfileSettings !== 'function') {
          apply = { ok: false, skipped: true, errorCode: 'unsupported', message: 'The selected graphics adapter cannot apply per-game driver settings.' };
        } else {
          try {
            // Always update the driver scope. Disabling Use Profile must
            // restore this executable to the global graphics settings.
            apply = await backend.setGameProfileSettings(targetDeviceId, safePath, graphics, assignment.enabled === true);
            if (xeFgRefusal) {
              apply = {
                ...apply,
                ok: false,
                perControl: { ...(apply?.perControl ?? {}), frameGenOverride: xeFgRefusal },
              };
            }
          } catch (err) {
            apply = { ok: false, errorCode: 'io-failed', message: err instanceof Error ? err.message : String(err) };
          }
        }
        return { settings: saved, apply };
      }),

      'game-settings-delete': async (payload) => {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('game-settings-delete: payload must be an object');
        const exePath = canonicalExePath(payload.exePath);
        if (!exePath) throw new Error('game-settings-delete: exePath must be an absolute Windows path');
        return await gameProfiles.deleteSettings(exePath);
      },

      'game-profiles-list': async (...args) => {
        assertNoPayload(args, 'game-profiles-list');
        const profiles = await store.loadProfiles();
        return { associations: await gameProfiles.load(new Set(profiles.map((p) => p.id))) };
      },

      'game-profile-save': async (payload) => {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('game-profile-save: payload must be an object');
        return serializeGameProfileMutation(async () => {
          const profiles = await store.loadProfiles();
          const profile = profiles.find((p) => p.id === payload.profileId);
          if (!profile) throw new Error('game-profile-save: profile not found');
          const exePath = canonicalExePath(payload.exePath);
          if (!exePath) throw new Error('game-profile-save: exePath must be an absolute Windows path');
          const clean = normalizeAssociation({ ...payload, exePath, profileId: profile.id });
          if (!clean) throw new Error('game-profile-save: invalid association');
          return { associations: await gameProfiles.upsert(clean, new Set(profiles.map((p) => p.id))) };
        });
      },

      'game-profile-delete': async (payload) => {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('game-profile-delete: payload must be an object');
        return serializeGameProfileMutation(async () => {
          const profiles = await store.loadProfiles();
          if (!profiles.some((p) => p.id === payload.profileId)) throw new Error('game-profile-delete: profile not found');
          return { associations: await gameProfiles.delete(payload.profileId, payload.exePath, new Set(profiles.map((p) => p.id))) };
        });
      },

      'profiles-save': async (profile) => {
        if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
          throw new Error('profiles-save: profile must be an object');
        }
        if (typeof profile.id !== 'string' || profile.id.length === 0) {
          throw new Error('profiles-save: id must be a non-empty string');
        }
        // M2b review F6: profile ids become Run-key values (startup-set) -
        // whitespace would silently break the startup-get round trip.
        if (!/^\S+$/.test(profile.id)) {
          throw new Error('profiles-save: id must not contain whitespace');
        }
        if (typeof profile.name !== 'string' || profile.name.trim().length === 0) {
          throw new Error('profiles-save: name must be a non-empty string');
        }
        if (typeof profile.ocOnBoot !== 'boolean') {
          throw new Error('profiles-save: ocOnBoot must be a boolean');
        }
        const settings = sanitizeSettings(profile.settings ?? {});
        const existing = (await store.loadProfiles()).find((p) => p.id === profile.id);
        await store.saveProfile({
          id: profile.id,
          name: profile.name.trim(),
          createdAt: existing?.createdAt ?? (typeof profile.createdAt === 'string' ? profile.createdAt : new Date().toISOString()),
          settings,
          ocOnBoot: profile.ocOnBoot,
          ...(profile.deviceKey !== undefined ? { deviceKey: profile.deviceKey } : {}),
          ...(profile.deviceName !== undefined ? { deviceName: profile.deviceName } : {}),
        });
        return { profiles: await store.loadProfiles(), settings: await store.loadSettings() };
      },

      'profiles-delete': async (id) => {
        if (typeof id !== 'string' || id.length === 0) {
          throw new Error('profiles-delete: id must be a non-empty string');
        }
        return serializeGameProfileMutation(async () => {
          await store.deleteProfile(id);
          const settings = await store.loadSettings();
          const activeMap = settings.activeProfileIds && typeof settings.activeProfileIds === 'object'
            ? Object.fromEntries(Object.entries(settings.activeProfileIds).filter(([, profileId]) => profileId !== id))
            : undefined;
          if (activeMap !== undefined || settings.activeProfileId === id) {
            await store.saveSettings({
              ...settings,
              activeProfileIds: activeMap ?? {},
              activeProfileId: settings.activeProfileId === id ? null : settings.activeProfileId,
            });
          }
          const remaining = await store.loadProfiles();
          // The optional sidecar is best-effort cleanup.  A corrupt/future
          // sidecar must not make the legacy profile delete action fail.
          try { await gameProfiles.cleanupProfile(id, new Set(remaining.map((p) => p.id))); } catch { /* surfaced by game-profiles-list */ }
          return { profiles: await store.loadProfiles(), settings: await store.loadSettings() };
        });
      },

      'profiles-rename': async (id, name) => {
        if (typeof id !== 'string' || id.length === 0) {
          throw new Error('profiles-rename: id must be a non-empty string');
        }
        if (typeof name !== 'string' || name.trim().length === 0) {
          throw new Error('profiles-rename: name must be a non-empty string');
        }
        const profiles = await store.loadProfiles();
        const profile = profiles.find((p) => p.id === id);
        if (!profile) throw new Error(`profiles-rename: profile '${id}' not found`);
        await store.saveProfile({ ...profile, name: name.trim() });
        return { profiles: await store.loadProfiles(), settings: await store.loadSettings() };
      },

      // Persisted-settings patch (activeProfileId / ocOnBoot + M4-D the
      // Settings-tab fields). Read-modify-write in main so the renderer can
      // never clobber waiverAccepted. M4-D2 (plan F4 / review F1): THIS
      // handler is the ONLY writer of the HKCU Run value (via the startup
      // adapter) - every settings save re-derives the value from the MERGED
      // intent (startWithWindows || (ocOnBoot && an active profile)), so a
      // missing/externally-deleted value self-heals on the next save.
      // One reg.exe call per save; a registry failure degrades to the
      // honest save envelope (the intent still persists and the renderer's
      // mismatch hint surfaces the disagreement until the next save
      // re-derives). The value write lands BEFORE the settings save: a
      // partial failure (save threw) leaves the registration ahead of the
      // intent - the renderer's catch re-queries startup-get and the
      // mismatch hint explains the disagreement honestly.
      'profiles-settings-save': async (patch) => {
        const save = async () => {
        if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
          throw new Error('profiles-settings-save: patch must be an object');
        }
        const cur = await store.loadSettings();
        const next = {
          waiverAccepted: cur.waiverAccepted,
          ocOnBoot: patch.ocOnBoot === undefined ? cur.ocOnBoot : patch.ocOnBoot === true,
          activeProfileId: patch.activeProfileId === undefined
            ? cur.activeProfileId
            : (typeof patch.activeProfileId === 'string' && patch.activeProfileId.length > 0 ? patch.activeProfileId : null),
          ...(patch.activeProfileIds !== undefined || cur.activeProfileIds !== undefined
            ? {
                activeProfileIds: patch.activeProfileIds === undefined
                  ? cur.activeProfileIds
                  : (patch.activeProfileIds && typeof patch.activeProfileIds === 'object' && !Array.isArray(patch.activeProfileIds)
                    ? patch.activeProfileIds
                    : {}),
              }
            : {}),
          // M3-C-E: the OC mode is never touched by the profiles patch.
          ocMode: cur.ocMode,
          // M157: preserve each physical GPU's tuning mode through this
          // unrelated read-modify-write channel.
          ...(cur.ocModes !== undefined ? { ocModes: cur.ocModes } : {}),
          // M4-B: the once-only Advanced-mode warning acceptance is never
          // touched by the profiles patch either.
          advancedModeAccepted: cur.advancedModeAccepted,
          // M4-D: the Settings-tab fields (startWithWindows/startMinimized)
          // - the Settings page persists them through this channel (absent
          // -> keep the current value, same read-modify-write rule).
          startWithWindows: patch.startWithWindows === undefined
            ? cur.startWithWindows
            : patch.startWithWindows === true,
          startMinimized: patch.startMinimized === undefined
            ? cur.startMinimized
            : patch.startMinimized === true,
          closeToTray: patch.closeToTray === undefined
            ? cur.closeToTray
            : patch.closeToTray === true,
          // M4-D2: the Monitoring "Log to file" toggle (same rule).
          monitorLogToFile: patch.monitorLogToFile === undefined
            ? cur.monitorLogToFile
            : patch.monitorLogToFile === true,
          // Monitoring log field selection is independent of the on/off
          // switch. Keep the field additive for legacy settings envelopes;
          // an explicit [] is valid and means log no metrics.
          ...(patch.monitorLogMetrics !== undefined || cur.monitorLogMetrics !== undefined
            ? {
                monitorLogMetrics: patch.monitorLogMetrics === undefined
                  ? cur.monitorLogMetrics
                  : normalizeMonitorLogMetrics(patch.monitorLogMetrics),
              }
            : {}),
          // M4-F (S3): the persisted GPU selection is NEVER chosen by the
          // profiles patch - the envelope carries it read-modify-write so
          // a Settings/Profiles save can never clobber device-set's write
          // M29: preserve both session id and durable identity; the patch
          // never chooses or clobbers the selected GPU.
          deviceId: Number.isInteger(cur.deviceId) && cur.deviceId >= 0 ? cur.deviceId : null,
          deviceKey: typeof cur.deviceKey === 'string' && cur.deviceKey.length > 0 ? cur.deviceKey : null,
          // 1.0.1 Themes (M4): the persisted UI theme rides the envelope
          // read-modify-write like the rest. An INVALID patch.theme keeps
          // the CURRENT theme - never a silent reset to 'dark' (the store
          // fallback stays 'dark' for absent fields on old files, but a
          // garbage patch must not blow away the user's choice).
          theme: patch.theme === undefined
            ? cur.theme
            : (THEMES.includes(patch.theme) ? patch.theme : cur.theme),
          // M5/M6: the software-overlay fields (the Overlay Settings page
          // persists them through this channel). The letter REJECTS with an
          // honest error when it is not exactly one letter (the rule:
          // CTRL + <letter> - the letter is the only changeable part); the
          // position REJECTS outside the four corners; the scale is CLAMPED
          // to the slider's 0.5..2.0 range (never rejected - the slider
          // cannot produce an out-of-range value).
          overlayEnabled: patch.overlayEnabled === undefined
            ? cur.overlayEnabled
            : patch.overlayEnabled === true,
          overlayHotkeyLetter: patch.overlayHotkeyLetter === undefined
            ? cur.overlayHotkeyLetter
            : validateOverlayHotkeyLetter(patch.overlayHotkeyLetter),
          overlayPosition: patch.overlayPosition === undefined
            ? cur.overlayPosition
            : validateOverlayPosition(patch.overlayPosition),
          overlayScale: patch.overlayScale === undefined
            ? cur.overlayScale
            : clampOverlayScale(patch.overlayScale),
          // M6: the overlay text color - REJECTS outside /^#[0-9a-fA-F]{6}$/
          // (the swatches + the type=color input can only produce that
          // shape; a garbage patch must never reach the renderer). The
          // stats NORMALIZE (known ids, deduped - never rejected: the
          // tickboxes can only produce known ids).
          overlayColor: patch.overlayColor === undefined
            ? cur.overlayColor
            : validateOverlayColor(patch.overlayColor),
          overlayStats: patch.overlayStats === undefined
            ? cur.overlayStats
            : normalizeOverlayStats(patch.overlayStats),
          // M35: overlay GPU monitoring selection - null/all is the old
          // behavior; the UI supplies durable device keys and the renderer
          // resolves them against the current enumeration.
          overlayDeviceKeys: patch.overlayDeviceKeys === undefined
            ? cur.overlayDeviceKeys
            : normalizeOverlayDeviceKeys(patch.overlayDeviceKeys),
          // M7b: the background box - enabled coerced like overlayEnabled,
          // the color REJECTS outside /^#[0-9a-fA-F]{6}$/ (the swatches +
          // the type=color input can only produce that shape), the opacity
          // CLAMPS to 0..1 (the slider cannot produce an out-of-range
          // value).
          overlayBgEnabled: patch.overlayBgEnabled === undefined
            ? cur.overlayBgEnabled
            : patch.overlayBgEnabled === true,
          overlayBgColor: patch.overlayBgColor === undefined
            ? cur.overlayBgColor
            : validateOverlayBgColor(patch.overlayBgColor),
          overlayBgOpacity: patch.overlayBgOpacity === undefined
            ? cur.overlayBgOpacity
            : clampOverlayBgOpacity(patch.overlayBgOpacity),
          // M17b: the chip-name row labels - coerced like overlayBgEnabled
          // (off = the stock 'CPU '/'GPU ' prefixes).
          overlayChipNames: patch.overlayChipNames === undefined
            ? cur.overlayChipNames
            : patch.overlayChipNames === true,
          // M17e: the overlay polling-rate - CLAMPED to the slider's
          // 100-2000 ms range (never rejected - the slider cannot produce
          // an out-of-range value; a garbage patch degrades to the 400 ms
          // default - M17g: the stock polling rate FLIPS 500 -> 400).
          overlayPollMs: patch.overlayPollMs === undefined
            ? cur.overlayPollMs
            : clampOverlayPollMs(patch.overlayPollMs),
          // M24: the overlay THEME - REJECTS outside classic|arc (the
          // Theme row's two buttons can only produce the two ids; a garbage
          // patch must never reach the overlay renderer - the
          // validateOverlayColor pattern).
          overlayTheme: patch.overlayTheme === undefined
            ? cur.overlayTheme
            : validateOverlayTheme(patch.overlayTheme),
          // M143: the ReLive/Shadowplay-style recording status pill is a
          // boolean Overlay preference; absent keeps the current value.
          overlayRecordingPill: patch.overlayRecordingPill === undefined
            ? cur.overlayRecordingPill
            : patch.overlayRecordingPill === true,
          // M23: the ADVANCED-overlay fields (the Overlay view's Advanced
          // card persists them through this channel - the M5 overlaySettings
          // pattern, new keys). The letter REJECTS with an honest error when
          // it is not exactly one letter (the rule: Control + <letter> - the
          // letter is the only changeable part; validateOverlayHotkeyLetter
          // normalizes UPPERCASE); the position REJECTS outside
          // left|right (the panel anchors to the PRIMARY display edge).
          // NO scale key - the panel is a fixed compact size.
          advancedOverlayEnabled: patch.advancedOverlayEnabled === undefined
            ? cur.advancedOverlayEnabled
            : patch.advancedOverlayEnabled === true,
          advancedOverlayHotkeyLetter: patch.advancedOverlayHotkeyLetter === undefined
            ? cur.advancedOverlayHotkeyLetter
            : validateOverlayHotkeyLetter(patch.advancedOverlayHotkeyLetter),
          advancedOverlayPosition: patch.advancedOverlayPosition === undefined
            ? cur.advancedOverlayPosition
            : validateAdvancedOverlayPosition(patch.advancedOverlayPosition),
        };
        // M23 THE CROSS-FIELD LETTER-COLLISION REJECTION AT THE ENVELOPE
        // (the STRUCTURAL guard - the renderer toasts are UX only): the two
        // hotkeys share ONE modifier pair (Control + <letter>), and
        // globalShortcut collisions within the SAME app are SILENT (a
        // register REPLACES the same-app registration and returns true - a
        // colliding pair in the store would kill one hotkey with
        // hotkeyRegistered still true and the honest note could not detect
        // it). The envelope therefore REJECTS a patch whose (patched ??)
        // persisted letters would collide - on BOTH sides, symmetrically:
        // an advancedOverlayHotkeyLetter equal to the effective
        // overlayHotkeyLetter, and an overlayHotkeyLetter equal to the
        // effective advancedOverlayHotkeyLetter. The comparison uses the
        // NORMALIZED UPPERCASE form (the letters persist uppercase - a
        // lowercase patch colliding with an uppercase persisted letter must
        // reject). The rejection throws BEFORE the store write - the store
        // stays unchanged, the save answers the honest error.
        if (patch.advancedOverlayHotkeyLetter !== undefined) {
          const advLetter = validateOverlayHotkeyLetter(patch.advancedOverlayHotkeyLetter);
          const hudLetter = patch.overlayHotkeyLetter !== undefined
            ? validateOverlayHotkeyLetter(patch.overlayHotkeyLetter)
            : cur.overlayHotkeyLetter;
          if (advLetter === hudLetter) {
            throw new Error('advancedOverlayHotkeyLetter must differ from the overlay hotkey letter (the Control+<letter> hotkeys would collide)');
          }
        }
        if (patch.overlayHotkeyLetter !== undefined) {
          const hudLetter = validateOverlayHotkeyLetter(patch.overlayHotkeyLetter);
          const advLetter = patch.advancedOverlayHotkeyLetter !== undefined
            ? validateOverlayHotkeyLetter(patch.advancedOverlayHotkeyLetter)
            : cur.advancedOverlayHotkeyLetter;
          if (hudLetter === advLetter) {
            throw new Error('overlayHotkeyLetter must differ from the advanced overlay hotkey letter (the Control+<letter> hotkeys would collide)');
          }
        }
        // M4-D2 (plan F4): derive the Run value from the merged intent and
        // write it through the startup adapter (write when true, delete when
        // false - one reg.exe call per save, mock-safe). M152: a multi-GPU
        // profile map is active when at least one mapped profile still exists;
        // the legacy scalar remains a compatibility fallback. A registry
        // failure degrades to the honest save envelope below (never a failed
        // save).
        let hasActiveProfile = Boolean(next.activeProfileId);
        try {
          hasActiveProfile = activeProfileEntries(next, await store.loadProfiles()).length > 0 || hasActiveProfile;
        } catch {
          // Keep the scalar fallback if the profile list is temporarily
          // unavailable; the persisted intent must still be saved.
        }
        try {
          await startup.set(
            next.startWithWindows === true
              || (next.ocOnBoot === true && hasActiveProfile),
          );
        } catch {
          // honest degradation: the persisted intent stays, the renderer's
          // mismatch hint (startup truth vs intent) surfaces the reg failure
        }
        await store.saveSettings(next);
        // M5: the overlay reaction (the rebuildTray pattern) - when any
        // overlay field the PATCH touched actually changed, the injected
        // callback gets the CHANGED fields so main.js applies the new
        // geometry/visibility/hotkey letter + sends 'overlay:settings' to
        // the overlay window. Best effort: a callback failure must never
        // fail the save.
        // M6: the color + the stats ride the same keys - without them a
        // color/stats change would persist but the overlay would never
        // re-render.
        // M7b: the three background keys ride the loop too - without them
        // a bg change persists but onOverlaySettings never fires and the
        // overlay never re-renders (the box would only appear on the next
        // boot).
        // M24: the theme key rides the loop too - without it a theme change
        // persists but onOverlaySettings never fires and the HUD never
        // re-renders (the switch would only apply on the next boot).
        const overlayChanged = {};
        for (const key of ['overlayEnabled', 'overlayHotkeyLetter', 'overlayPosition', 'overlayScale', 'overlayColor', 'overlayStats', 'overlayDeviceKeys', 'overlayBgEnabled', 'overlayBgColor', 'overlayBgOpacity', 'overlayChipNames', 'overlayPollMs', 'overlayTheme', 'overlayRecordingPill']) {
          if (patch[key] !== undefined && next[key] !== cur[key]) overlayChanged[key] = next[key];
        }
        if (Object.keys(overlayChanged).length > 0) {
          try {
            await onOverlaySettings(overlayChanged);
          } catch (err) {
            console.log(`[overlay] settings reaction failed: ${err.message}`);
          }
        }
        // M23: the ADVANCED-overlay reaction (the onOverlaySettings
        // pattern, second consumer) - when any advancedOverlay* field the
        // PATCH touched actually changed, the injected callback gets the
        // CHANGED fields so main.js applies the new
        // geometry/visibility/hotkey letter + sends
        // 'advanced-overlay:settings' to the panel window. Best effort: a
        // callback failure must never fail the save.
        const advancedOverlayChanged = {};
        for (const key of ['advancedOverlayEnabled', 'advancedOverlayHotkeyLetter', 'advancedOverlayPosition', 'overlayStats', 'theme']) {
          if (patch[key] !== undefined && next[key] !== cur[key]) advancedOverlayChanged[key] = next[key];
        }
        if (Object.keys(advancedOverlayChanged).length > 0) {
          try {
            await onAdvancedOverlaySettings(advancedOverlayChanged);
          } catch (err) {
            console.log(`[advanced-overlay] settings reaction failed: ${err.message}`);
          }
        }
        // M17e (round-2 N4, the overlay polling-rate slider): the LIVE
        // RESTART - the device telemetry push reads pollMs ONCE at
        // svc.start(), so a change must stop + restart the push with the
        // new interval (never a next-boot-only change - the user's
        // complaint was the 500 ms cadence). Best effort: a failure leaves
        // the push on the old cadence (the next boot applies the new one).
        // M17e (round-2 N3): the restart loop includes the NULL_DEVICE_KEY
        // entry - its telemetry-map entry carries a stop, so the no-Intel
        // lane honors a changed overlayPollMs too (the device lane already
        // did; the null lane never read the value before - the slider was
        // dead on the GTX 980 box).
        if (overlayChanged.overlayPollMs !== undefined) {
          const ids = [...telemetry.entries()]
            .filter(([, svc]) => typeof svc.stop === 'function')
            .map(([id]) => id);
          for (const id of ids) {
            try { await telemetry.get(id).stop(); } catch { /* best effort */ }
            telemetry.delete(id);
          }
          for (const id of ids) {
            try {
              if (id === NULL_DEVICE_KEY) await startNullTelemetry();
              else await startTelemetry(id);
            } catch { /* best effort */ }
          }
        }
        return next;
        };
        const queued = settingsSaveQueue.then(save, save);
        settingsSaveQueue = queued.then(() => undefined, () => undefined);
        return queued;
      },

      // M3-C-E/M157: the OC mode is persisted per physical GPU. The scalar
      // remains a compatibility fallback for old settings files; an
      // inventory key is required before a mixed-session toggle can be
      // stored or routed to one adapter.
      'oc-mode-get': async (deviceId = null) => {
        if (deviceId !== null && (!Number.isInteger(deviceId) || deviceId < 0)) {
          throw new Error('oc-mode-get takes no payload or a valid device id');
        }
        const s = await store.loadSettings();
        if (deviceId === null) return { ocMode: s.ocMode };
        const target = await modeTarget(deviceId);
        const deviceKey = typeof target?.deviceKey === 'string' ? target.deviceKey : null;
        const saved = deviceKey && s.ocModes && typeof s.ocModes === 'object' ? s.ocModes[deviceKey] : null;
        return { ocMode: OC_MODES.includes(saved) ? saved : s.ocMode, deviceKey };
      },

      'oc-mode-set': async (ocMode, deviceId = null) => {
        if (!OC_MODES.includes(ocMode)) {
          throw new Error(`oc-mode-set: ocMode must be one of ${OC_MODES.join(', ')}`);
        }
        if (deviceId !== null) assertValidDeviceId(deviceId);
        const cur = await store.loadSettings();
        let deviceKey = null;
        if (deviceId !== null) {
          const target = await modeTarget(deviceId);
          deviceKey = typeof target?.deviceKey === 'string' ? target.deviceKey : null;
        }
        const ocModes = deviceKey
          ? { ...(cur.ocModes ?? {}), [deviceKey]: ocMode }
          : cur.ocModes;
        // A targeted toggle changes only the keyed override. Keep the scalar
        // as the legacy/default mode for every physical GPU without an
        // override; changing it here would make the other adapter appear to
        // switch modes too. The no-id form retains the old global behavior.
        await store.saveSettings({
          ...cur,
          ...(deviceId === null ? { ocMode } : {}),
          ...(ocModes !== undefined ? { ocModes } : {}),
        });
        // Invalidate only the selected device's caps cache. Its ranges are
        // re-derived from the new mode; every other adapter keeps its own
        // tuning surface untouched.
        if (typeof backend.setOcMode === 'function') {
          await backend.setOcMode(ocMode, deviceId);
        }
        return deviceId === null ? { ocMode } : { ocMode, deviceKey };
      },

      // M4-B: the Advanced OC Mode warning is accepted ONCE and
      // persisted - the renderer shows the disclaimer only on the FIRST
      // Stock->Advanced toggle and skips it on every later boot. There is
      // no revoke path (nothing resets the acceptance), mirroring the
      // waiver's persisted-acceptance pattern.
      'advanced-mode-accepted-get': async (...args) => {
        assertNoPayload(args, 'advanced-mode-accepted-get');
        const s = await store.loadSettings();
        return { accepted: s.advancedModeAccepted === true };
      },

      'advanced-mode-accepted-set': async (...args) => {
        assertNoPayload(args, 'advanced-mode-accepted-set');
        const cur = await store.loadSettings();
        await store.saveSettings({ ...cur, advancedModeAccepted: true });
        return { accepted: true };
      },

      // Rebuild the tray menu after any profile change (M2b-B). The product
      // path injects the tray ref; the default is a no-op so tests and
      // --ui-verify never depend on a tray existing.
      'tray-rebuild': async (...args) => {
        assertNoPayload(args, 'tray-rebuild');
        await rebuildTray();
        return { ok: true };
      },
    };

    // M2D: the mock-featureset channels exist ONLY in mock mode (mock ctx
    // injected by ipc.js/main.js). Real mode has no such channel - invoking
    // it rejects with the honest "No handler registered" 404.
    if (mock) {
      handlers['mock:list-featuresets'] = async (...args) => {
        assertNoPayload(args, 'mock:list-featuresets');
        return mock.listFeaturesets();
      };
      handlers['mock:set-featureset'] = async (id) => {
        if (typeof id !== 'string' || id.length === 0) {
          throw new Error('mock:set-featureset: id must be a non-empty string');
        }
        return mock.setFeatureset(id);
      };
      // M4-D2: the boot-apply flow probe. mock.runBootApply runs the REAL
      // window-path boot apply (applyRunner-less, defaults-fallback
      // skipped - the exact unelevated-boot semantics) and records the
      // outcome in the mock apply log; ui-verify asserts the log records
      // the active profile with no refusal.
      if (typeof mock.runBootApply === 'function') {
        handlers['mock:run-boot-apply'] = async (...args) => {
          assertNoPayload(args, 'mock:run-boot-apply');
          return mock.runBootApply();
        };
      }
      if (typeof mock.bootApplyLog === 'function') {
        handlers['mock:boot-apply-log'] = async (...args) => {
          assertNoPayload(args, 'mock:boot-apply-log');
          return mock.bootApplyLog();
        };
      }
    }

    return { handlers, stopAllTelemetry };
}
