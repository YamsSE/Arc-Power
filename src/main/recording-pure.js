// Pure contracts shared by the Recording main-process seams and tests.
import path from 'node:path';

export const RECORDING_SCHEMA_VERSION = 1;
export const RECORDING_MODES = ['manual', 'clips'];
export const RECORDING_RUNTIME_DIRECTORY = 'recording-runtime';
const LEGACY_RECORDING_MODES = Object.freeze({
  'manual-only': 'manual',
  'full-matches': 'manual',
  'clips-only': 'clips',
  'always-on': 'manual',
});
export const RECORDING_FPS = [30, 60, 120];
export const RECORDING_RESOLUTIONS = [
  { id: 'default', width: 0, height: 0, label: 'Default' },
  { id: '480p', width: 854, height: 480, label: '480p' },
  { id: '720p', width: 1280, height: 720, label: '720p' },
  { id: '900p', width: 1600, height: 900, label: '900p' },
  { id: '1080p', width: 1920, height: 1080, label: '1080p' },
  { id: '1440p', width: 2560, height: 1440, label: '1440p' },
  { id: '4k', width: 3840, height: 2160, label: '4K' },
];
// Video-only bitrate guidance in Kbps. 4K intentionally has an open-ended
// practical upper range, represented by a generous UI/storage ceiling while
// retaining the requested 15,000-25,000+ guidance.
export const RECORDING_BITRATE_RANGES = Object.freeze({
  default: Object.freeze({ min: 4000, max: 8000, step: 100, default: 8000, label: '4,000–8,000 Kbps' }),
  '480p': Object.freeze({ min: 1500, max: 2500, step: 100, default: 2000, label: '1,500–2,500 Kbps' }),
  '720p': Object.freeze({ min: 2500, max: 5000, step: 100, default: 3500, label: '2,500–5,000 Kbps' }),
  '900p': Object.freeze({ min: 3500, max: 7000, step: 100, default: 5000, label: '3,500–7,000 Kbps' }),
  '1080p': Object.freeze({ min: 4000, max: 8000, step: 100, default: 6000, label: '4,000–8,000 Kbps' }),
  '1440p': Object.freeze({ min: 8000, max: 12000, step: 100, default: 10000, label: '8,000–12,000 Kbps' }),
  '4k': Object.freeze({ min: 15000, max: 50000, step: 500, default: 20000, label: '15,000–25,000+ Kbps' }),
});
export const DEFAULT_RECORDING_SETTINGS = Object.freeze({
  location: '',
  runtimePath: '',
  mode: 'manual',
  fps: 60,
  resolution: '1080p',
  encoderId: 'automatic',
  bitrateKbps: 8000,
  replayLengthSec: 30,
  hotkeys: { start: 'F9', stop: 'F10', saveClip: 'F8' },
});
export const SAFE_VIDEO_EXTENSIONS = Object.freeze(['.mp4', '.mkv', '.mov', '.webm', '.m4v']);
export const ASCENT_MAX_MESSAGE_BYTES = 8096;

export function recordingBitrateRange(resolution = DEFAULT_RECORDING_SETTINGS.resolution) {
  return RECORDING_BITRATE_RANGES[resolution] ?? RECORDING_BITRATE_RANGES.default;
}

export function clampRecordingBitrate(value, resolution = DEFAULT_RECORDING_SETTINGS.resolution) {
  const range = recordingBitrateRange(resolution);
  const numeric = Number.isFinite(value) ? Math.round(value) : range.default;
  const clamped = Math.min(range.max, Math.max(range.min, numeric));
  return Math.round(clamped / range.step) * range.step;
}

function boundedString(value, fallback = '', max = 1024) {
  return typeof value === 'string' && value.length <= max ? value : fallback;
}

export function recordingAbsolutePath(value, label = 'location') {
  if (typeof value !== 'string' || value.length > 4096 || !value.trim()) throw new Error(`${label} must be a non-empty path`);
  const candidate = value.trim();
  if (!path.isAbsolute(candidate) && !path.win32.isAbsolute(candidate)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(candidate);
}

const ELECTRON_MODIFIERS = new Map([
  ['commandorcontrol', 'CommandOrControl'],
  ['control', 'Control'],
  ['alt', 'Alt'],
  ['shift', 'Shift'],
]);

function canonicalAccelerator(value) {
  if (typeof value !== 'string') return null;
  const parts = value.trim().replace(/\s+/g, '').split('+');
  if (parts.length < 1 || parts.some((part) => !part)) return null;
  const key = parts.pop().toUpperCase();
  if (!/^(?:F(?:[1-9]|1[0-9]|2[0-4])|[A-Z0-9])$/.test(key)) return null;
  const modifiers = [];
  for (const part of parts) {
    const modifier = ELECTRON_MODIFIERS.get(part.toLowerCase());
    if (!modifier || modifiers.includes(modifier)) return null;
    modifiers.push(modifier);
  }
  return [...modifiers, key].join('+');
}

export function normalizeRecordingAccelerator(value, fallback) {
  const normalized = canonicalAccelerator(value);
  if (normalized) return normalized;
  const normalizedFallback = canonicalAccelerator(fallback);
  return normalizedFallback ?? fallback;
}

function normalizeHotkey(value, fallback) {
  return normalizeRecordingAccelerator(boundedString(value, fallback, 32), fallback);
}

export function normalizeRecordingSettings(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const resolution = RECORDING_RESOLUTIONS.some((item) => item.id === source.resolution)
    ? source.resolution : DEFAULT_RECORDING_SETTINGS.resolution;
  const bitrate = clampRecordingBitrate(source.bitrateKbps, resolution);
  const replayLength = Number.isFinite(source.replayLengthSec) ? Math.round(source.replayLengthSec) : DEFAULT_RECORDING_SETTINGS.replayLengthSec;
  const hotkeys = source.hotkeys && typeof source.hotkeys === 'object' ? source.hotkeys : {};
  return {
    location: boundedString(source.location, DEFAULT_RECORDING_SETTINGS.location, 4096),
    runtimePath: boundedString(source.runtimePath, DEFAULT_RECORDING_SETTINGS.runtimePath, 4096),
    mode: RECORDING_MODES.includes(source.mode)
      ? source.mode
      : (LEGACY_RECORDING_MODES[source.mode] ?? DEFAULT_RECORDING_SETTINGS.mode),
    fps: RECORDING_FPS.includes(source.fps) ? source.fps : DEFAULT_RECORDING_SETTINGS.fps,
    resolution,
    encoderId: boundedString(source.encoderId, DEFAULT_RECORDING_SETTINGS.encoderId, 128),
    bitrateKbps: bitrate,
    replayLengthSec: Math.min(3600, Math.max(5, replayLength)),
    hotkeys: {
      start: normalizeHotkey(hotkeys.start, DEFAULT_RECORDING_SETTINGS.hotkeys.start),
      stop: normalizeHotkey(hotkeys.stop, DEFAULT_RECORDING_SETTINGS.hotkeys.stop),
      saveClip: normalizeHotkey(hotkeys.saveClip, DEFAULT_RECORDING_SETTINGS.hotkeys.saveClip),
    },
  };
}

export function normalizeEncoderStates(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === 'object' && typeof item.type === 'string')
    .map((item) => ({
      type: item.type.slice(0, 128),
      description: boundedString(item.description, item.type, 256),
      enumerated: true,
      probeValid: item.probeValid === true || item.valid === true,
      startTested: item.startTested === true,
      startSupported: item.startSupported !== false,
      code: Number.isInteger(item.code) ? item.code : null,
      status: boundedString(item.status, '', 256),
    }));
}

export function safeVideoExtension(filePath) {
  const ext = path.extname(String(filePath)).toLowerCase();
  return SAFE_VIDEO_EXTENSIONS.includes(ext) ? ext : null;
}

export function sortRecordingClips(clips) {
  return [...(Array.isArray(clips) ? clips : [])].sort((a, b) => {
    const date = String(b?.createdAt ?? '').localeCompare(String(a?.createdAt ?? ''));
    return date || String(a?.fileName ?? '').localeCompare(String(b?.fileName ?? ''), undefined, { numeric: true, sensitivity: 'base' });
  });
}

function isJsonWhitespace(code) {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * Consume complete JSON objects from Ascent's undelimited stdio stream.
 * The native transport has no newline framing, so this tracks strings and
 * nested braces and leaves incomplete trailing data for the next chunk.
 */
export function consumeAscentJsonObjects(previous, chunk, maxBytes = ASCENT_MAX_MESSAGE_BYTES) {
  let buffer = `${previous ?? ''}${chunk ?? ''}`;
  if (Buffer.byteLength(buffer, 'utf8') > maxBytes * 4) throw new Error('Ascent output buffer exceeded its safety bound');
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let cursor = 0;
  while (cursor < buffer.length) {
    const code = buffer.charCodeAt(cursor);
    if (start < 0) {
      if (code === 0x7b) { start = cursor; depth = 1; }
      else if (!isJsonWhitespace(code)) throw new Error('Unexpected bytes in Ascent JSON stream');
      cursor += 1;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (code === 0x5c) escaped = true;
      else if (code === 0x22) inString = false;
    } else if (code === 0x22) inString = true;
    else if (code === 0x7b) depth += 1;
    else if (code === 0x7d) depth -= 1;
    cursor += 1;
    if (depth === 0) {
      const raw = buffer.slice(start, cursor);
      if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error('Ascent JSON message exceeded its safety bound');
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ascent message must be a JSON object');
      objects.push(value);
      start = -1;
      inString = false;
      escaped = false;
      while (cursor < buffer.length && isJsonWhitespace(buffer.charCodeAt(cursor))) cursor += 1;
    }
  }
  return { objects, remainder: start >= 0 ? buffer.slice(start) : '' };
}

export function isPathWithinRoot(rootPath, candidatePath, { allowRoot = false } = {}) {
  if (typeof rootPath !== 'string' || typeof candidatePath !== 'string') return false;
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const rootKey = process.platform === 'win32' ? root.toLowerCase() : root;
  const candidateKey = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  if (allowRoot && candidateKey === rootKey) return true;
  const prefix = rootKey.endsWith(path.sep) ? rootKey : `${rootKey}${path.sep}`;
  return candidateKey.startsWith(prefix);
}

export function resolveRecordingRuntimeCandidates({ configuredPath, portableWrapperPath, resourcesPath, devPath, buildKind } = {}) {
  const candidates = [];
  if (configuredPath) candidates.push(path.resolve(configuredPath));
  // Packaged builds carry the native runtime as an Electron extraResource,
  // which is available beside app.asar for both installed and portable runs.
  if (resourcesPath) candidates.push(path.join(path.resolve(resourcesPath), RECORDING_RUNTIME_DIRECTORY));
  // Keep the sibling lookup for a portable wrapper launched from a checkout
  // or for older builds that staged the runtime beside the wrapper.
  if (portableWrapperPath) candidates.push(path.join(path.dirname(path.resolve(portableWrapperPath)), RECORDING_RUNTIME_DIRECTORY));
  if (devPath) candidates.push(path.join(path.resolve(devPath), RECORDING_RUNTIME_DIRECTORY));
  return [...new Set(candidates)];
}
