import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { spawn as spawnProcess } from 'node:child_process';
import { consumeAscentJsonObjects, ASCENT_MAX_MESSAGE_BYTES, recordingOutputDimensions, resolveRecordingRuntimeCandidates, normalizeRecordingAudioSettings, recordingRuntimeEncoderIdForTarget } from './recording-pure.js';
import { createInstantReplaySaveState, INSTANT_REPLAY_SAVE_STATUS } from './recording-lifecycle.js';
import { createApmCapture } from './apm-capture.js';

export const ASCENT_COMMANDS = Object.freeze({ SHUTDOWN: 1, QUERY_MACHINE_INFO: 2, START: 3, STOP: 4, START_REPLAY_CAPTURE: 8, STOP_REPLAY_CAPTURE: 9, SPLIT_VIDEO: 12 });
export const ASCENT_RECORDER_TYPES = Object.freeze({ VIDEO: 1, REPLAY: 2, STREAMING: 3 });
export const ASCENT_EVENTS = Object.freeze({ QUERY_MACHINE_INFO: 1, ERR: 2, READY: 3, RECORDING_STARTED: 4, RECORDING_STOPPING: 5, RECORDING_STOPPED: 6, VIDEO_FILE_SPLIT: 8, REPLAY_STARTED: 9, REPLAY_STOPPING: 10, REPLAY_STOPPED: 11, REPLAY_ARMED: 12, REPLAY_CAPTURE_VIDEO_STARTED: 13, REPLAY_CAPTURE_VIDEO_READY: 14, REPLAY_ERROR: 15 });
export const ASCENT_ENCODER_START_ERROR_CODES = Object.freeze([-6, -8]);
export const ASCENT_QSV_ENCODER_PREFERENCE = Object.freeze(['obs_qsv11_av1', 'obs_qsv11_hevc', 'obs_qsv11_v2']);
export const RECORDING_GPU_ENCODER_SELECTION_PREFIX = 'arc-gpu-encoder:v1:';
const DEFAULT_SHUTDOWN_MS = 1500;
const DEFAULT_PROBE_MS = 15000;
// The native replay muxer can signal replay_ready before Windows releases the
// source handle. Keep the save operation in its finalizing state long enough
// for that handle to drain; publishing the rolling source during this window
// is what previously produced 40-second "10-second" clips.
const REPLAY_FILE_WAIT_MS = 5000;
const REPLAY_FILE_STABLE_MS = 200;
// Keep retries bounded. A save must either publish a verified bounded file or
// fail cleanly; waiting a full minute only to publish the rolling source is
// worse than surfacing a retryable error.
const REPLAY_TRIM_RETRY_MS = 5000;
const REPLAY_FILE_CLEANUP_WAIT_MS = 1000;
const REPLAY_CAPTURE_RETRY_DELAY_MS = 500;
const REPLAY_CAPTURE_RETRY_MS = 30000;
// Keep a small lead-in in the native rolling buffer. Ascent needs roughly
// half a second of keyframe history to produce a complete head duration; the
// user-facing destination is still trimmed back to the requested duration.
const REPLAY_CAPTURE_LEAD_MS = 750;
// Ascent acknowledges START_REPLAY_CAPTURE before its replay muxer has
// finished opening the capture. Sending STOP in the same event turn can race
// that initialization and return "not capturing" for longer head durations.
const REPLAY_CAPTURE_START_SETTLE_MS = 300;

/**
 * FFmpeg writes these two informational lines while a normal output closes.
 * They are not actionable recording failures, so keep them out of the
 * renderer-facing status while preserving every other stderr line.
 */
export function filterRecordingStderr(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/\bQavg\b/i.test(line) && !/frames left in the queue on closing/i.test(line))
    .join('\n');
}

export function runtimeExecutablePath(runtimeRoot) {
  if (!runtimeRoot || typeof runtimeRoot !== 'string') return null;
  const root = path.resolve(runtimeRoot);
  const exe = path.join(root, 'bin', '64bit', 'ascent-obs.exe');
  try { return fs.statSync(exe).isFile() ? exe : null; } catch { return null; }
}

export function resolveAscentRuntime(options = {}) {
  for (const root of resolveRecordingRuntimeCandidates(options)) {
    const executable = runtimeExecutablePath(root);
    if (executable) return { root, executable };
  }
  return null;
}

/** Build every command with the fields the Ascent server transports. */
export function buildAscentCommand(command, identifier, recorderType = ASCENT_RECORDER_TYPES.VIDEO, fields = {}) {
  if (!Number.isSafeInteger(command) || command < 1) throw new Error('Ascent command must have a numeric command id');
  if (!Number.isSafeInteger(identifier) || identifier < 0) throw new Error('Ascent command must have a numeric identifier');
  if (!Number.isSafeInteger(recorderType) || recorderType < 1) throw new Error('Ascent command must have a numeric recorder type');
  return { ...fields, cmd: command, identifier, recorder_type: recorderType };
}

function positiveDimension(value) {
  const dimension = Number(value);
  return Number.isFinite(dimension) && dimension > 0 ? Math.max(2, Math.round(dimension)) : null;
}

function captureDimensionsOf(settings = {}) {
  const width = positiveDimension(settings.captureWidth ?? settings.baseWidth);
  const height = positiveDimension(settings.captureHeight ?? settings.baseHeight);
  return {
    width: width ?? 1920,
    height: height ?? 1080,
  };
}

function captureSourceOf(settings = {}) {
  const source = settings.captureSource && typeof settings.captureSource === 'object' ? settings.captureSource : {};
  const showCursor = settings.showCursor === true;
  if (source.type === 'window' && Number.isSafeInteger(source.windowHandle) && source.windowHandle > 0) {
    return {
      monitor: { enable: false, force: false, cursor: showCursor, monitor_handle: 0 },
      // Ascent-OBS names this source window_capture. Sending it as "window"
      // is silently ignored by the runtime, leaving no active source and
      // producing the generic command error (-4) on program capture.
      window_capture: { enable: true, force: true, cursor: showCursor, window_handle: source.windowHandle },
    };
  }
  const monitorHandle = Number.isSafeInteger(source.monitorHandle) && source.monitorHandle >= 0 && source.monitorHandle <= 0xffffffff
    ? source.monitorHandle
    : 0;
  return { monitor: { enable: true, force: false, cursor: showCursor, monitor_handle: monitorHandle } };
}

function colorSettingsOf(settings = {}) {
  const mode = settings.captureColorMode;
  const hdr = mode === 'hdr' || (mode !== 'sdr' && settings.captureHdr === true);
  return hdr
    ? { color_format: 'P010', color_space: 'Rec2100PQ' }
    : { color_format: 'NV12', color_space: 'Rec709' };
}

function encoderProfileOf(encoderId) {
  // obs-qsv11 uses the normal OBS profile names. H.264 supports High while
  // HEVC and AV1 use Main. Keeping this codec-specific prevents H.264 from
  // silently falling back to a less efficient Main profile.
  return encoderId === 'obs_qsv11_v2' || encoderId === 'obs_qsv11_soft_v2' ? 'high' : 'main';
}

function runtimeEncoderIdOf(encoderId, requestedRuntimeEncoderId) {
  const expectedNonDisplayId = recordingRuntimeEncoderIdForTarget(encoderId, false);
  return requestedRuntimeEncoderId === expectedNonDisplayId ? requestedRuntimeEncoderId : encoderId;
}

function replayCaptureDurationMsOf(requestedDurationMs, replayLengthSec = null) {
  const durationMs = Math.max(1, Math.round(Number(requestedDurationMs) || 0));
  const bufferMs = Number.isFinite(Number(replayLengthSec))
    ? Math.max(0, Math.round(Number(replayLengthSec) * 1000))
    : 0;
  // Ascent's replay muxer rejects a capture whose head exactly equals a
  // round-number buffer boundary. Request the user duration plus a small
  // lead-in from the internally enlarged buffer; FFmpeg bounds the published
  // destination back to the exact requested duration below.
  return bufferMs > 0 && durationMs >= bufferMs
    ? durationMs + REPLAY_CAPTURE_LEAD_MS
    : durationMs;
}

function isUsableEncoder(encoder) {
  return encoder?.enumerated === true && encoder.probeValid === true && encoder.startSupported === true;
}

function unsupportedEncoderError(requested, encoders) {
  const available = (Array.isArray(encoders) ? encoders : []).filter(isUsableEncoder).map((encoder) => encoder.type);
  const suffix = available.length ? ` Usable encoders: ${available.join(', ')}.` : ' The runtime did not report a usable Intel QSV encoder.';
  const error = new Error(requested === 'automatic'
    ? `Intel AV1 is not available from the bundled ascent-obs runtime. Select Intel H264 or Intel HEVC explicitly if you want to use another codec.${suffix}`
    : `Encoder '${requested}' is not valid or start-supported by the bundled ascent-obs runtime. Select a valid H264, HEVC, or AV1 encoder.${suffix}`);
  error.code = 'UNSUPPORTED_ENCODER';
  return error;
}

// Windows reports a native ascent-obs access violation as either the unsigned
// NTSTATUS value (3221225477) or its signed int32 representation
// (-1073741819). Treat both forms as a recoverable child crash so a transient
// QSV/DXGI initialization fault does not leave Instant Replay offline until
// the whole desktop is restarted.
function isNativeChildCrash(error) {
  const code = Number(error?.code);
  const unsignedCode = Number.isFinite(code) ? (code >>> 0) : null;
  if (unsignedCode === 0xc0000005) return true;
  return /Ascent exited \((?:3221225477|-1073741819)\)/i.test(String(error?.message ?? ''));
}

function invalidEncoderSelectionError(value) {
  const error = new Error(`Encoder selection '${String(value)}' is malformed or does not contain a stable physical adapter target.`);
  error.code = 'INVALID_ENCODER_SELECTION';
  return error;
}

function integerOf(value) {
  if (typeof value === 'string' && !value.trim()) return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function luidOf(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value) && value.length >= 2) {
    const low = luidOf(value[0]);
    const high = luidOf(value[1]);
    return low && high ? `${high}:${low}` : null;
  }
  if (!value || typeof value !== 'object') return null;
  const low = value.low ?? value.LowPart ?? value.lowPart;
  const high = value.high ?? value.HighPart ?? value.highPart;
  if (low === undefined || high === undefined) return null;
  const lowText = luidOf(low);
  const highText = luidOf(high);
  return lowText && highText ? `${highText}:${lowText}` : null;
}

function normalizedAdapterTarget(value) {
  if (!value || typeof value !== 'object') return null;
  const deviceKeyValue = value.deviceKey ?? value.device_key ?? value.k;
  const deviceKey = typeof deviceKeyValue === 'string' && deviceKeyValue.trim() ? deviceKeyValue.trim() : null;
  const bdfValue = value.bdf ?? value.b;
  const bdfSource = Array.isArray(bdfValue)
    ? { domain: bdfValue[0], bus: bdfValue[1], device: bdfValue[2], function: bdfValue[3] }
    : bdfValue && typeof bdfValue === 'object' ? bdfValue : null;
  const domain = integerOf(bdfSource?.domain) ?? 0;
  const bus = integerOf(bdfSource?.bus);
  const device = integerOf(bdfSource?.device);
  const func = integerOf(bdfSource?.function);
  const bdf = bus !== null && device !== null && func !== null && domain >= 0 && bus >= 0 && device >= 0 && func >= 0
    ? { domain, bus, device, function: func }
    : null;
  const luid = luidOf(value.luid ?? value.adapterLuid ?? value.adapter_luid ?? value.l);
  if (!deviceKey && !bdf && !luid) return null;
  return {
    ...(deviceKey ? { deviceKey } : {}),
    ...(bdf ? { bdf } : {}),
    ...(luid ? { luid } : {}),
  };
}

function encoderAdapterTarget(encoder) {
  if (!encoder || typeof encoder !== 'object') return null;
  const nested = encoder.adapter_target ?? encoder.adapterTarget ?? encoder.target;
  return normalizedAdapterTarget(nested) ?? normalizedAdapterTarget(encoder);
}

function adapterTargetHasIdentity(target) {
  const normalized = normalizedAdapterTarget(target);
  return Boolean(normalized?.deviceKey || normalized?.bdf || normalized?.luid);
}

function adapterTargetsMatch(left, right) {
  const a = normalizedAdapterTarget(left);
  const b = normalizedAdapterTarget(right);
  if (!a || !b) return false;
  let compared = false;
  if (a.deviceKey && b.deviceKey) {
    compared = true;
    if (a.deviceKey !== b.deviceKey) return false;
  }
  if (a.bdf && b.bdf) {
    compared = true;
    if (JSON.stringify(a.bdf) !== JSON.stringify(b.bdf)) return false;
  }
  if (a.luid && b.luid) {
    compared = true;
    if (a.luid !== b.luid) return false;
  }
  return compared;
}

function encoderDemotionKey(codec, target) {
  const normalized = normalizedAdapterTarget(target);
  return `${codec}|${normalized ? JSON.stringify(normalized) : 'legacy'}`;
}

function encoderTargetMatchesSelection(encoder, target) {
  const runtimeTarget = encoderAdapterTarget(encoder);
  return runtimeTarget ? adapterTargetsMatch(runtimeTarget, target) : !adapterTargetHasIdentity(target);
}

function encoderTargetUnavailableError(requested) {
  const error = new Error(`Encoder selection '${requested}' does not match a concrete adapter target reported by the recording runtime.`);
  error.code = 'ENCODER_TARGET_UNAVAILABLE';
  return error;
}

/**
 * Decode the renderer's versioned GPU+codec ID. Legacy global encoder IDs
 * intentionally return null so callers can continue handling them unchanged.
 */
export function parseRecordingEncoderSelection(value) {
  if (typeof value !== 'string' || !value.startsWith(RECORDING_GPU_ENCODER_SELECTION_PREFIX)) return null;
  try {
    const encoded = value.slice(RECORDING_GPU_ENCODER_SELECTION_PREFIX.length);
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      // Accept the first development-format IDs as a migration courtesy.
      parsed = JSON.parse(decodeURIComponent(encoded));
    }
    if (!parsed || typeof parsed !== 'object') throw invalidEncoderSelectionError(value);
    const codec = typeof parsed.codec === 'string' ? parsed.codec : parsed.c;
    if (!ASCENT_QSV_ENCODER_PREFERENCE.includes(codec)) throw invalidEncoderSelectionError(value);
    const compactTarget = parsed.target ?? {
      ...(typeof parsed.k === 'string' ? { deviceKey: parsed.k } : {}),
      ...(Array.isArray(parsed.b) ? { bdf: parsed.b } : {}),
      ...(parsed.l !== undefined ? { luid: parsed.l } : {}),
    };
    const adapterTarget = normalizedAdapterTarget(compactTarget);
    if (!adapterTarget) throw invalidEncoderSelectionError(value);
    const deviceName = typeof parsed.deviceName === 'string' && parsed.deviceName.trim() ? parsed.deviceName.trim() : undefined;
    return { codec, target: adapterTarget, ...(deviceName ? { deviceName } : {}) };
  } catch (error) {
    if (error?.code === 'INVALID_ENCODER_SELECTION') throw error;
    throw invalidEncoderSelectionError(value);
  }
}

export function resolveRecordingEncoder(requested, encoders) {
  const selection = parseRecordingEncoderSelection(requested);
  const encoderId = selection?.codec ?? requested;
  const usable = (Array.isArray(encoders) ? encoders : []).filter(isUsableEncoder);
  if (encoderId === 'automatic') {
    // Automatic is intentionally AV1-only for Intel Arc. Falling back to a
    // different codec would silently change the user's configured output.
    if (usable.some((encoder) => encoder.type === 'obs_qsv11_av1')) return 'obs_qsv11_av1';
    throw unsupportedEncoderError(encoderId, encoders);
  }
  if (!ASCENT_QSV_ENCODER_PREFERENCE.includes(encoderId) || !usable.some((encoder) => encoder.type === encoderId)) {
    throw unsupportedEncoderError(encoderId, encoders);
  }
  return encoderId;
}

export function resolveRecordingEncoderSelection(requested, encoders) {
  const selection = parseRecordingEncoderSelection(requested);
  const encoderId = resolveRecordingEncoder(requested, encoders);
  if (selection?.target) {
    const runtimeEncoders = (Array.isArray(encoders) ? encoders : [])
      .filter((encoder) => encoder?.type === encoderId);
    const hasRuntimeTargetMetadata = runtimeEncoders.some((encoder) => adapterTargetHasIdentity(encoderAdapterTarget(encoder)));
    if (hasRuntimeTargetMetadata && !runtimeEncoders.some((encoder) => encoderTargetMatchesSelection(encoder, selection.target))) {
      throw encoderTargetUnavailableError(requested);
    }
  }
  return {
    encoderId,
    adapterTarget: selection?.target ?? null,
    selection,
  };
}

function audioDeviceId(deviceId) {
  return typeof deviceId === 'string' && deviceId.trim() ? deviceId.trim() : 'default';
}

function audioVolumePercent(value) {
  return Math.round(Math.min(1, Math.max(0, Number(value) || 0)) * 100);
}

export function buildRecordingAudioSettings(settings = {}) {
  const audio = normalizeRecordingAudioSettings(settings.audio);
  const microphone = audio.microphone;
  const system = audio.system;
  const inputDeviceId = audioDeviceId(microphone.deviceId);
  const outputDeviceId = audioDeviceId(system.deviceId);
  const processCaptureEnabled = audio.sourceMode === 'custom';
  const outputEnabled = system.enabled && !processCaptureEnabled;
  // Ascent-OBS's WASAPI controls consume integer percentage volume values
  // (0-100), while Arc Power stores the UI value as a normalized 0-1 number.
  // Passing 1 for the UI default of 1.0 made every source effectively 1%
  // volume, which presented as "no audio" in the resulting recording.
  const inputVolume = audioVolumePercent(microphone.volume);
  const outputVolume = audioVolumePercent(system.volume);
  const inputSource = {
    // The bundled runtime uses a numeric type only when device_id is
    // "default"; string labels here would make the default microphone look
    // like an output source. Explicit device ids are classified by WASAPI.
    type: 1,
    device_id: inputDeviceId,
    name: 'input_mic',
    enable: microphone.enabled,
    volume: inputVolume,
    mono: microphone.mono,
    use_device_timing: false,
    tracks: 5,
  };
  const outputSource = {
    type: 0,
    device_id: outputDeviceId,
    name: 'output_game',
    enable: outputEnabled,
    volume: outputVolume,
    mono: false,
    use_device_timing: true,
    tracks: 3,
  };
  return {
    sample_rate: 48000,
    mono: false,
    input: { type: 'wasapi_input_capture', device_id: inputDeviceId, enable: microphone.enabled, volume: inputVolume, mono: microphone.mono },
    output: { type: 'wasapi_output_capture', device_id: outputDeviceId, enable: outputEnabled, volume: outputVolume, mono: false },
    extra_options: {
      sample_rate: 48000,
      source_mode: audio.sourceMode,
      audio_sources: [inputSource, outputSource],
      audio_capture_process2: audio.customProcesses.map((processName) => ({
        process_name: processName,
        enable: processCaptureEnabled,
        volume: outputVolume,
        mono: false,
        tracks: 3,
      })),
    },
  };
}

function normalizeAudioDevices(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const object = item && typeof item === 'object' ? item : {};
    const entry = Object.entries(object);
    const protocolPair = entry.length === 1 && !('device_id' in object) && !('deviceId' in object) && !('id' in object) && !('name' in object)
      ? entry[0]
      : null;
    const rawDeviceId = String(object.device_id ?? object.id ?? object.deviceId ?? protocolPair?.[1] ?? (typeof item === 'string' ? item : '')).slice(0, 512);
    const deviceId = rawDeviceId.toLowerCase() === 'default' ? '' : rawDeviceId;
    const name = deviceId
      ? String(object.name ?? object.description ?? protocolPair?.[0] ?? `Audio device ${index + 1}`).slice(0, 512)
      : 'Default device';
    return { id: deviceId || `audio-default-${index}`, deviceId, name };
  }).filter((item) => item.deviceId || item.name);
}

export function buildAscentStartPayload(settings, outputPath, recorderType = ASCENT_RECORDER_TYPES.VIDEO, identifier = 0) {
  const capture = captureDimensionsOf(settings);
  const output = recordingOutputDimensions(settings.resolution, capture.width, capture.height);
  const outputWidth = output.width;
  const outputHeight = output.height;
  const selection = parseRecordingEncoderSelection(settings.encoderId);
  const encoderId = selection?.codec ?? settings.encoderId;
  // The canonical encoder ID remains the app's persisted/demotion identity.
  // Only the internal runtime ID changes for a concrete non-display target;
  // this selects Ascent's cross-adapter QSV path without losing GPU ownership
  // in the UI or profile store.
  const runtimeEncoderId = runtimeEncoderIdOf(encoderId, settings.runtimeEncoderId);
  const adapterTarget = normalizedAdapterTarget(settings.encoderTarget ?? selection?.target);
  // The app keeps the complete stable identity (device key/BDF/LUID) for
  // matching, persistence, and diagnostics. The recording runtime must get
  // only the resolved DXGI LUID, however: when BDF and LUID are sent
  // together, older Ascent/OBS adapter selection can fall back to adapter 0
  // (the display-output GPU) before QSV is created. `runtimeAdapterTarget` is
  // supplied by the main-process resolver immediately before START.
  const runtimeAdapterTarget = normalizedAdapterTarget(settings.runtimeAdapterTarget);
  const adapterTargetPayload = runtimeAdapterTarget?.luid
    ? { luid: runtimeAdapterTarget.luid }
    : adapterTarget ? {
      ...(adapterTarget.deviceKey ? { device_key: adapterTarget.deviceKey } : {}),
      ...(adapterTarget.bdf ? { bdf: adapterTarget.bdf } : {}),
      ...(adapterTarget.luid ? { luid: adapterTarget.luid } : {}),
    } : null;
  return buildAscentCommand(ASCENT_COMMANDS.START, identifier, recorderType, {
    sources: captureSourceOf(settings),
    video_settings: {
      fps: settings.fps,
      // The base canvas is the monitor's native capture size. The requested
      // output remains independent so 4K always produces a 4K file.
      base_width: capture.width,
      base_height: capture.height,
      output_width: outputWidth,
      output_height: outputHeight,
      // Video initialization happens before the encoder object is created;
      // the runtime resolves this stable physical target before OBS/QSV starts.
      ...(adapterTargetPayload ? { adapter_target: adapterTargetPayload } : {}),
      // Make the OBS color pipeline explicit instead of depending on the
      // runtime's empty-extra-settings defaults. NV12 + Rec.709 + partial
      // range is the normal SDR hardware-capture path and keeps the encoded
      // file's color metadata aligned with the pixels sent to the encoder.
      extra_options: colorSettingsOf(settings),
      video_encoder: {
        id: runtimeEncoderId,
        ...(adapterTargetPayload ? { adapter_target: adapterTargetPayload } : {}),
        // Ascent-OBS maps the QSV name "quality" to TU1, which is the
        // Intel Media SDK best-quality target usage. Sending the semantic
        // value keeps the setting explicit and avoids relying on a numeric
        // default while retaining the user-controlled CBR bitrate.
        preset: 'quality',
        target_usage: 'quality',
        rate_control: 'CBR',
        // Older bundled Ascent builds read this legacy flag when selecting
        // their rate-control path. Keep it alongside the explicit modern
        // value so every included runtime stays on quality CBR instead of
        // silently falling back to its default quality mode.
        cbr: true,
        bitrate: settings.bitrateKbps,
        max_bitrate: settings.bitrateKbps,
        profile: encoderProfileOf(runtimeEncoderId),
        keyint_sec: 2,
        latency: 'normal',
        bframes: 3,
        enhancements: true,
      },
    },
    audio_settings: buildRecordingAudioSettings(settings),
    // Replay output is a rolling buffer. It must not inherit a normal
    // recording filename, otherwise stopping the buffer can finalize a full
    // recording session. Save Clip supplies its own path below.
    ...(recorderType === ASCENT_RECORDER_TYPES.VIDEO ? {
      file_output: { filename: outputPath, format: 'mp4', max_file_size_bytes: 0, enbale_on_demand_spilt_video: false, include_full_video: true },
    } : {}),
    ...(recorderType === ASCENT_RECORDER_TYPES.REPLAY ? {
      replay: {
        // The extra second is internal headroom for keyframes and muxer
        // startup. The Save Clip destination remains the configured length.
        max_time_sec: Number.isFinite(Number(settings.replayLengthSec))
          ? Math.max(1, Math.ceil(Number(settings.replayLengthSec) + 1))
          : settings.replayLengthSec,
      },
    } : {}),
  });
}

function isEncoderStartRejection(error) {
  return Number.isInteger(error?.code) && ASCENT_ENCODER_START_ERROR_CODES.includes(error.code);
}

export function createAscentEngine({ runtimeResolver = resolveAscentRuntime, spawn = spawnProcess, clock = () => Date.now(), onState = () => {}, onEncoderDemoted = async () => {}, getCaptureDimensions = () => null, resolveEncoderTarget = async (target) => target, trimReplayClip = null, apmCapture = createApmCapture({ clock }), shutdownMs = DEFAULT_SHUTDOWN_MS, startTimeoutMs = 15000, replayTrimRetryMs = REPLAY_TRIM_RETRY_MS } = {}) {
  let child = null;
  let output = '';
  let decoder = new StringDecoder('utf8');
  let nextIdentifier = 1;
  let disposed = false;
  let protocolFailure = null;
  let terminationStarted = false;
  // Video recording and the replay buffer are separate Ascent recorder
  // instances. Keep their identities independently so one STOP cannot
  // accidentally tear down the other capture.
  const activeRecorders = new Map();
  const startingRecorders = new Map();
  const completedCaptures = [];
  let replayCapture = null;
  // A replay-ready response can arrive before the native muxer has released
  // its output. Keep a short-lived marker after the capture identity is
  // cleared so a following START can retry a transient backend busy window
  // instead of surfacing a generic Ascent timeout.
  let replayCaptureReadyAt = 0;
  // Ascent keeps the OBS output object alive after STOP. A later START in
  // that same child can therefore retain the previous encoder/bitrate even
  // though the new JSON payload is correct. Recreate the child before the
  // next capture so every applied profile reaches a fresh OBS output.
  let freshChildRequired = false;
  const demotedEncoders = new Set();
  let state = { available: false, running: false, mode: null, activeModes: { video: false, replay: false }, startedAt: null, sessionId: null, error: null, encoders: [], audioInputs: [], audioOutputs: [], probeComplete: false, lastEvent: null, instantReplaySave: createInstantReplaySaveState() };
  const listeners = new Set();
  const pending = new Map();
  const writeQueue = [];
  // Start the APM sampler when a capture is accepted locally, rather than
  // waiting for a best-effort STARTED event from older runtimes. The event
  // still confirms the recorder, but it must not reset the sampler timeline.
  const apmSessionsStarted = new Set();
  const retiredChildren = new WeakSet();
  let closingChild = null;
  let writing = false;
  let lifecycle = Promise.resolve();
  // Every Save Clip entry point calls this shared method. Claim the slot
  // before queueing the serialized operation so renderer IPC and global
  // hotkeys cannot enqueue two native captures at once.
  let replayClipSaveInFlight = false;
  let machineInfoReady = false;
  let replayCrashRecoveryInFlight = false;
  // A replay clip finalization failure can require recycling the native replay
  // buffer. Keep that internal stop/start cycle out of the public lifecycle
  // stream so the desktop toast does not claim that Instant Replay stopped
  // while the recovery is already bringing it back.
  let replayBufferRecoveryInFlight = false;

  function startApmSession(recorder) {
    const sessionId = recorder?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId || apmSessionsStarted.has(sessionId)) return;
    try {
      apmCapture?.start?.(sessionId, recorder.startedAt ?? clock());
      apmSessionsStarted.add(sessionId);
    } catch { /* APM remains optional and must never block capture */ }
  }

  function stopApmSession(recorder) {
    const sessionId = recorder?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId || !apmSessionsStarted.has(sessionId)) return null;
    apmSessionsStarted.delete(sessionId);
    try { return apmCapture?.stop?.(sessionId) ?? null; } catch { return null; }
  }

  function recorderForMode(mode, { starting = false } = {}) {
    return (starting ? startingRecorders : activeRecorders).get(mode) ?? null;
  }

  function findRecorderForEvent(mode, identifier, { preferStarting = false } = {}) {
    const starting = recorderForMode(mode, { starting: true });
    const active = recorderForMode(mode);
    if (preferStarting && starting && (identifier === null || starting.identifier === identifier)) return starting;
    if (active && (identifier === null || active.identifier === identifier)) return active;
    if (starting && (identifier === null || starting.identifier === identifier)) return starting;
    return null;
  }

  function captureStatePatch() {
    const active = [...activeRecorders.values()];
    const activeModes = {
      video: activeRecorders.has('video'),
      replay: activeRecorders.has('replay'),
    };
    const startedAt = active.length
      ? Math.min(...active.map((recorder) => Number.isFinite(recorder.startedAt) ? recorder.startedAt : clock()))
      : null;
    const sessionRecorder = activeRecorders.get('replay') ?? activeRecorders.get('video');
    return {
      running: active.length > 0,
      // Keep the historical single mode field for consumers that only show
      // one label. activeModes is authoritative when both are running.
      mode: activeModes.video ? 'video' : activeModes.replay ? 'replay' : null,
      activeModes,
      startedAt,
      sessionId: sessionRecorder ? `${sessionRecorder.mode}:${sessionRecorder.identifier}` : null,
    };
  }

  function serialize(operation) {
    const run = lifecycle.then(operation, operation);
    lifecycle = run.catch(() => {});
    return run;
  }

  const publish = (patch) => {
    state = { ...state, ...patch };
    onState(state);
    for (const cb of listeners) cb(state);
  };

  function publishInstantReplaySave(status, details = {}) {
    const next = createInstantReplaySaveState(status, details);
    publish({ instantReplaySave: next });
    return next;
  }

  const rejectPending = (err) => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(err); }
    pending.clear();
  };

  const rejectQueued = (err) => {
    while (writeQueue.length > 0) writeQueue.shift().reject(err);
  };

  function terminateChild() {
    const target = child;
    if (!target || terminationStarted) return;
    terminationStarted = true;
    try { target.stdin?.destroy(); } catch {}
    try { target.stdout?.destroy(); } catch {}
    try { if (target.exitCode === null && !target.killed) target.kill(); } catch {}
  }

  function failProtocol(error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    protocolFailure = failure;
    output = '';
    decoder = new StringDecoder('utf8');
    activeRecorders.clear();
    startingRecorders.clear();
    replayCapture = null;
    replayCaptureReadyAt = 0;
    for (const sessionId of apmSessionsStarted) {
      try { apmCapture?.stop?.(sessionId); } catch { /* best effort */ }
    }
    apmSessionsStarted.clear();
    machineInfoReady = false;
    publish({ available: false, ...captureStatePatch(), error: `Ascent protocol error: ${failure.message}` });
    rejectPending(failure);
    rejectQueued(failure);
    terminateChild();
  }

  function handleMessage(message) {
    const event = Number.isInteger(message?.event) ? message.event : null;
    if (event === null) return;
    const identifier = Number.isInteger(message.identifier) ? message.identifier : null;
    const stopped = event === ASCENT_EVENTS.RECORDING_STOPPED || event === ASCENT_EVENTS.REPLAY_STOPPED;
    const started = event === ASCENT_EVENTS.RECORDING_STARTED || event === ASCENT_EVENTS.REPLAY_STARTED;
    const eventMode = event === ASCENT_EVENTS.REPLAY_STARTED || event === ASCENT_EVENTS.REPLAY_STOPPED ? 'replay' : 'video';
    if (event === ASCENT_EVENTS.READY) {
      for (const recorder of startingRecorders.values()) {
        if (identifier === null || identifier === recorder.identifier) recorder.ready = true;
      }
    }
    const recorderForEvent = started
      ? findRecorderForEvent(eventMode, identifier, { preferStarting: true })
      : stopped
        ? findRecorderForEvent(eventMode, identifier)
        : null;
    if (started && recorderForEvent) {
      const active = { ...recorderForEvent, startedAt: recorderForEvent.startedAt ?? clock() };
      activeRecorders.set(recorderForEvent.mode, active);
      startApmSession(active);
      if (recorderForEvent.cancelRequested) {
        recorderForEvent.startedAfterCancel = true;
        if (!recorderForEvent.stopInFlight) {
          void stopInternal(recorderForEvent.mode).catch((error) => {
            // Keep the active recorder intact when recovery fails so the user can
            // retry Stop. Surface the backend failure instead of creating an
            // unhandled rejection from this event-driven recovery path.
            publish({ error: `The recording started after cancellation and could not be stopped automatically: ${error?.message ?? String(error)}. Stop recording manually.` });
          });
        }
      } else {
        startingRecorders.delete(recorderForEvent.mode);
      }
    }
    if (event === ASCENT_EVENTS.REPLAY_CAPTURE_VIDEO_READY
      && replayCapture
      && (replayCapture.captureIdentifier === identifier || replayCapture.bufferIdentifier === identifier)) {
      // replay_ready only means that Ascent has answered the STOP request. On
      // Windows the muxer can still hold the native output while FFmpeg
      // bounds it. Keep the identity until the save path has finished its
      // duration correction so a failed correction can be recovered before a
      // second Save Clip starts.
      replayCapture.phase = 'ready';
      replayCapture.readyAt = clock();
      replayCaptureReadyAt = replayCapture.readyAt;
    }
    if (event === ASCENT_EVENTS.REPLAY_STOPPED) {
      replayCapture = null;
      replayCaptureReadyAt = 0;
    }
    if (stopped && recorderForEvent) {
      const apmSession = stopApmSession(recorderForEvent);
      // Keep one bounded, identity-safe completion envelope so the IPC layer
      // can attach APM samples to ordinary recordings as well as replay clips.
      // Replay-buffer captures have no output path and are handled by the
      // replay-ready save path instead.
      if (recorderForEvent.mode === 'video' && typeof recorderForEvent.outputPath === 'string' && recorderForEvent.outputPath.trim()) {
        const samples = Array.isArray(apmSession?.samples) ? apmSession.samples.map((item) => ({ atMs: item.atMs, apm: item.apm })) : [];
        completedCaptures.push({
          mode: recorderForEvent.mode,
          sessionId: recorderForEvent.sessionId,
          outputPath: recorderForEvent.outputPath,
          sourceStartMs: 0,
          sourceEndMs: Math.max(0, Math.round(clock() - Number(recorderForEvent.startedAt ?? clock()))),
          ...(samples.length ? {
            apmSamples: samples,
            apmAverage: Math.round(samples.reduce((sum, item) => sum + item.apm, 0) / samples.length),
            apmPeak: Math.max(...samples.map((item) => item.apm)),
          } : {}),
          apmAvailable: apmSession?.sourceReady === true,
        });
        if (completedCaptures.length > 8) completedCaptures.splice(0, completedCaptures.length - 8);
      }
      const stoppedActive = activeRecorders.get(recorderForEvent.mode);
      if (identifier === null || stoppedActive?.identifier === identifier) activeRecorders.delete(recorderForEvent.mode);
      const starting = startingRecorders.get(recorderForEvent.mode);
      if (identifier === null || !starting || identifier === starting.identifier) {
        // Keep a timed-out/cancel-requested pending start until it has either
        // produced STARTED or the child exits. A STOPPED event can race ahead
        // of that STARTED event; dropping the identity here would make a
        // later backend capture impossible for stop() to reach.
        if (!starting?.cancelRequested || stoppedActive) startingRecorders.delete(recorderForEvent.mode);
      }
    }
    const startedMode = recorderForEvent?.mode ?? (event === ASCENT_EVENTS.REPLAY_STARTED ? 'replay' : 'video');
    const suppressReplayRecoveryStopState = stopped
      && eventMode === 'replay'
      && replayBufferRecoveryInFlight;
    publish({
      lastEvent: { ...message, at: clock() },
      ...(started && recorderForEvent ? { ...captureStatePatch(), error: null } : {}),
      ...(stopped && !suppressReplayRecoveryStopState ? captureStatePatch() : {}),
    });
    let waiter = identifier === null ? null : pending.get(identifier);
    let waiterIdentifier = identifier;
    // The bundled runtime's machine-info response is a transport-level
    // response and intentionally omits an identifier. Only a request that
    // explicitly opted into this behavior may consume it.
    if (!waiter && identifier === null) {
      const match = [...pending.entries()].find(([, item]) => item.acceptUnidentified && item.events.includes(event));
      if (match) {
        waiterIdentifier = match[0];
        waiter = match[1];
      }
    }
    if (!waiter) return;
    if (event === ASCENT_EVENTS.ERR || event === ASCENT_EVENTS.REPLAY_ERROR) {
      pending.delete(waiterIdentifier);
      clearTimeout(waiter.timer);
      const commandError = new Error(message.desc || `Ascent command failed (${message.code ?? 'unknown'})`);
      if (Number.isInteger(message.code)) commandError.code = message.code;
      commandError.event = event;
      waiter.reject(commandError);
      return;
    }
    if (waiter.events.includes(event)) {
      pending.delete(waiterIdentifier);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  function onStdout(chunk) {
    try {
      const parsed = consumeAscentJsonObjects(output, decoder.write(chunk), ASCENT_MAX_MESSAGE_BYTES);
      output = parsed.remainder;
      for (const message of parsed.objects) handleMessage(message);
    } catch (error) {
      failProtocol(error);
    }
  }

  function enqueue(payload) {
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, 'utf8') > ASCENT_MAX_MESSAGE_BYTES) throw new Error('Ascent command exceeded its 8096-byte safety bound');
    return new Promise((resolve, reject) => {
      writeQueue.push({ serialized, resolve, reject });
      void drain();
    });
  }

  async function drain() {
    if (writing || !child?.stdin || child.stdin.destroyed) return;
    writing = true;
    while (writeQueue.length > 0 && child?.stdin && !child.stdin.destroyed) {
      const item = writeQueue.shift();
      try {
        await new Promise((resolve, reject) => child.stdin.write(item.serialized, (err) => err ? reject(err) : resolve()));
        item.resolve();
      } catch (error) {
        item.reject(error);
      }
    }
    writing = false;
  }

  function ensureChild() {
    if (child && !child.killed) return child;
    if (disposed) throw new Error('Ascent engine is shut down');
    // A child may have emitted exit while its stdio is still closing. Retire
    // it before replacing the process so late events cannot affect the new
    // runtime, while still allowing its own stderr-close flush to complete
    // when no replacement has started yet.
    if (closingChild) {
      retiredChildren.add(closingChild);
      closingChild = null;
    }
    if (child) retiredChildren.add(child);
    const runtime = runtimeResolver();
    if (!runtime) {
      publish({ available: false, error: 'Bundled ascent-obs runtime is unavailable' });
      throw new Error('Bundled ascent-obs runtime is unavailable');
    }
    terminationStarted = false;
    protocolFailure = null;
    machineInfoReady = false;
    const spawnedChild = spawn(runtime.executable, [], { cwd: runtime.root, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    child = spawnedChild;
    output = '';
    decoder = new StringDecoder('utf8');
    const stderrState = { output: '', decoder: new StringDecoder('utf8'), flushed: false };
    spawnedChild.stdout?.on('data', (chunk) => {
      if (!retiredChildren.has(spawnedChild)) onStdout(chunk);
    });
    spawnedChild.stderr?.on('data', (chunk) => {
      if (retiredChildren.has(spawnedChild)) return;
      const text = stderrState.output + stderrState.decoder.write(chunk);
      const lines = text.split(/\r?\n/);
      stderrState.output = lines.pop() ?? '';
      const diagnostic = filterRecordingStderr(lines.join('\n')).slice(0, 512);
      if (diagnostic) publish({ error: diagnostic });
    });
    const flushStderr = () => {
      if (stderrState.flushed) return;
      stderrState.flushed = true;
      const trailingStderr = stderrState.output + stderrState.decoder.end();
      stderrState.output = '';
      const diagnostic = filterRecordingStderr(trailingStderr).slice(0, 512);
      if (diagnostic && !retiredChildren.has(spawnedChild)) publish({ error: diagnostic });
      if (closingChild === spawnedChild) closingChild = null;
    };
    spawnedChild.stderr?.once('close', flushStderr);
    spawnedChild.on('error', (error) => {
      // A timed-out shutdown can report its error after the replacement
      // child has already started. Never let the old process overwrite the
      // state or pending commands belonging to the replacement.
      if (retiredChildren.has(spawnedChild)) return;
      activeRecorders.clear();
      startingRecorders.clear();
      publish({ available: false, ...captureStatePatch(), error: error.message });
      rejectPending(error);
      rejectQueued(error);
    });
    // ChildProcess 'close' follows 'exit' and all stdio streams closing. The
    // stderr close handler covers implementations that expose that boundary
    // without emitting a child close event; the guard makes either path one-shot.
    spawnedChild.once('close', flushStderr);
    spawnedChild.on('exit', (code, signal) => {
      if (retiredChildren.has(spawnedChild) || child !== spawnedChild) return;
      const failure = protocolFailure;
      const crashed = !failure && !disposed && isNativeChildCrash({ code, message: `Ascent exited (${code ?? signal ?? 'unknown'})` });
      const replayRecorder = activeRecorders.get('replay') ?? startingRecorders.get('replay');
      const replayRecoverySettings = replayRecorder?.settings ?? null;
      const replayWasStarting = startingRecorders.has('replay');
      const replaySessions = [...activeRecorders.values(), ...startingRecorders.values()]
        .filter((recorder) => recorder?.sessionId);
      closingChild = spawnedChild;
      child = null;
      activeRecorders.clear();
      startingRecorders.clear();
      replayCapture = null;
      replayCaptureReadyAt = 0;
      terminationStarted = false;
      for (const recorder of replaySessions) stopApmSession(recorder);
      const exitError = failure ?? Object.assign(new Error(`Ascent exited (${code ?? signal ?? 'unknown'})`), {
        code: Number.isInteger(code) ? code : undefined,
        signal: signal ?? null,
      });
      publish({ available: false, ...captureStatePatch(), error: failure ? `Ascent protocol error: ${failure.message}` : disposed ? null : exitError.message });
      rejectPending(exitError);
      rejectQueued(exitError);
      protocolFailure = null;
      // Replay is a rolling buffer and can be recreated without losing a
      // finished file. Queue one bounded recovery after an access violation;
      // manual recordings stay stopped so their output path is never reused.
      if (crashed && replayRecoverySettings && !replayWasStarting && !replayCrashRecoveryInFlight) {
        replayCrashRecoveryInFlight = true;
        void serialize(async () => {
          try {
            await waitMs(REPLAY_CAPTURE_RETRY_DELAY_MS);
            machineInfoReady = false;
            await probeInternal();
            await startInternal(replayRecoverySettings, 'replay', false);
          } catch (recoveryError) {
            publish({ error: `Instant Replay could not recover after the capture runtime crashed: ${recoveryError?.message ?? String(recoveryError)}` });
          } finally {
            replayCrashRecoveryInFlight = false;
          }
        }).catch(() => { replayCrashRecoveryInFlight = false; });
      }
    });
    publish({ available: true, error: null, probeComplete: false });
    return child;
  }

  async function closeChildGracefully() {
    const target = child;
    if (!target) return;
    retiredChildren.add(target);
    try { await enqueue(buildAscentCommand(ASCENT_COMMANDS.SHUTDOWN, nextIdentifier++, ASCENT_RECORDER_TYPES.VIDEO)); } catch { /* kill fallback below */ }
    await new Promise((resolve) => {
      if (target.exitCode !== null || target.killed) return resolve();
      const timer = setTimeout(() => {
        try { target.kill(); } catch { /* best effort */ }
        resolve();
      }, shutdownMs);
      target.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (child === target) child = null;
    terminationStarted = false;
    machineInfoReady = false;
    rejectPending(new Error('Ascent process restarted'));
    rejectQueued(new Error('Ascent process restarted'));
  }

  async function prepareFreshChild() {
    if (!freshChildRequired) return;
    // A running recorder must keep the shared Ascent child alive. If the
    // other capture is still active, defer the fresh-child restart until the
    // last recorder has stopped.
    if (activeRecorders.size > 0 || startingRecorders.size > 0) return;
    freshChildRequired = false;
    await closeChildGracefully();
  }

  function request(command, recorderType, fields, events, timeoutMs = 5000, requestedIdentifier = null, { acceptUnidentified = false } = {}) {
    ensureChild();
    const identifier = Number.isSafeInteger(requestedIdentifier) ? requestedIdentifier : nextIdentifier++;
    const full = buildAscentCommand(command, identifier, recorderType, fields);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(identifier);
        const timeout = new Error('Timed out waiting for Ascent');
        timeout.code = 'ASCENT_TIMEOUT';
        reject(timeout);
      }, timeoutMs);
      pending.set(identifier, { resolve, reject, timer, events, acceptUnidentified });
      try {
        enqueue(full).catch((error) => { pending.delete(identifier); clearTimeout(timer); reject(error); });
      } catch (error) {
        pending.delete(identifier);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async function probeInternal() {
    try {
      // The first ascent-obs machine-info query can take several seconds while
      // Windows initializes QSV/WASAPI. Keep the renderer responsive, but do
      // not turn a slow cold start into a permanently pending UI state.
      const response = await request(ASCENT_COMMANDS.QUERY_MACHINE_INFO, ASCENT_RECORDER_TYPES.VIDEO, {}, [ASCENT_EVENTS.QUERY_MACHINE_INFO], DEFAULT_PROBE_MS, null, { acceptUnidentified: true });
      const encoders = Array.isArray(response.vid_encs) ? response.vid_encs.map((encoder) => {
        const type = String(encoder.type ?? '');
        const target = encoderAdapterTarget(encoder);
        const demoted = demotedEncoders.has(encoderDemotionKey(type, target))
          || (!target && demotedEncoders.has(encoderDemotionKey(type, null)));
        const valid = encoder.valid === true;
        return { ...encoder, type, enumerated: true, probeValid: valid && !demoted, startTested: demoted, startSupported: valid && !demoted, code: demoted ? -8 : null, status: demoted ? 'start rejected' : valid ? '' : 'invalid' };
      }) : [];
      const audioInputs = normalizeAudioDevices(response.adio_in_devs ?? response.audio_in_devs);
      const audioOutputs = normalizeAudioDevices(response.adio_out_devs ?? response.audio_out_devs);
      publish({ encoders, audioInputs, audioOutputs, probeComplete: true, error: null });
      machineInfoReady = true;
      return { ...state, encoders, audioInputs, audioOutputs };
    } catch (error) {
      machineInfoReady = false;
      const detail = error instanceof Error ? error.message : String(error);
      const failure = /^Ascent protocol error:/i.test(String(state.error ?? ''))
        ? state.error
        : `Recording runtime check failed: ${detail}`;
      publish({
        available: false,
        encoders: [],
        audioInputs: [],
        audioOutputs: [],
        probeComplete: false,
        error: failure,
      });
      throw error;
    }
  }

  async function startInternal(settings, mode = 'video', retryAfterCrash = true) {
    if (activeRecorders.has(mode) || startingRecorders.has(mode)) throw new Error(`${mode === 'replay' ? 'Instant Replay' : 'Recording'} is already active or a previous start is still pending`);
    await prepareFreshChild();
    // The startup probe already validates the bundled runtime and publishes
    // its encoder/audio inventory. Re-querying machine info before every
    // capture added an avoidable round trip to every button/hotkey action.
    // Query again only after a child restart or a failed initial probe.
    if (!machineInfoReady) await probeInternal();
    const outputPath = settings.outputPath;
    const type = mode === 'replay' ? ASCENT_RECORDER_TYPES.REPLAY : ASCENT_RECORDER_TYPES.VIDEO;
    // Never replace an explicit user selection with Automatic after a failed
    // start. That made a rejected H264/HEVC start appear to succeed while the
    // runtime silently recorded AV1 instead. The selection must either be
    // honored or fail with the actual encoder availability message.
    const resolvedEncoder = resolveRecordingEncoderSelection(settings.encoderId, state.encoders);
    let resolvedAdapterTarget = resolvedEncoder.adapterTarget;
    let runtimeEncoderId = resolvedEncoder.encoderId;
    if (resolvedAdapterTarget) {
      // The renderer carries the stable physical identity in the selected
      // GPU+codec id. Resolve that identity to the DXGI LUID in the main
      // process immediately before starting OBS/QSV; this keeps the
      // encoder choice bound to the selected physical adapter even when
      // the runtime's machine-info inventory is global. Any bridge failure
      // is propagated: a concrete choice must never start unresolved.
      const targetResolution = await resolveEncoderTarget(resolvedAdapterTarget, resolvedEncoder.encoderId);
      resolvedAdapterTarget = normalizedAdapterTarget(targetResolution) ?? resolvedAdapterTarget;
      if (typeof targetResolution?.runtimeEncoderId === 'string') runtimeEncoderId = targetResolution.runtimeEncoderId;
    }
    const demotionKeys = new Set([
      encoderDemotionKey(resolvedEncoder.encoderId, resolvedEncoder.adapterTarget),
      encoderDemotionKey(resolvedEncoder.encoderId, resolvedAdapterTarget),
    ]);
    if ([...demotionKeys].some((key) => demotedEncoders.has(key))) {
      throw unsupportedEncoderError(resolvedEncoder.encoderId, state.encoders);
    }
    let captureDimensions = null;
    try { captureDimensions = await getCaptureDimensions?.(settings); } catch { /* display enumeration is best effort */ }
    const payload = buildAscentStartPayload({
      ...settings,
      encoderId: resolvedEncoder.encoderId,
      runtimeEncoderId,
      // Keep the original identity for app-side matching and persistence;
      // runtimeAdapterTarget is deliberately reduced to the resolved LUID in
      // the START payload.
      encoderTarget: resolvedEncoder.adapterTarget,
      runtimeAdapterTarget: resolvedAdapterTarget,
      ...captureDimensions,
    }, outputPath, type);
    const identifier = nextIdentifier++;
    const fields = Object.fromEntries(Object.entries(payload).filter(([key]) => !['cmd', 'identifier', 'recorder_type'].includes(key)));
    const startingRecorder = { identifier, type, mode, ready: false, sessionId: `${mode}:${identifier}`, startedAt: clock(), outputPath: typeof outputPath === 'string' ? outputPath : null, settings };
    startingRecorders.set(mode, startingRecorder);
    startApmSession(startingRecorder);
    try {
      await request(payload.cmd, type, fields, [mode === 'replay' ? ASCENT_EVENTS.REPLAY_STARTED : ASCENT_EVENTS.RECORDING_STARTED], startTimeoutMs, identifier);
    } catch (error) {
      const startingRecorder = startingRecorders.get(mode);
      if (startingRecorder?.identifier === identifier && error?.code === 'ASCENT_TIMEOUT' && startingRecorder.ready) {
        // A READY event means the backend accepted the start, but the actual
        // started event may still arrive after the request window. Keep the
        // recorder identity so a late event becomes an active capture that
        // stop() can control; competing starts remain blocked meanwhile.
        startingRecorder.timedOut = true;
        publish({ error: 'Recording start is still pending; stop to cancel it.' });
      } else if (startingRecorder?.identifier === identifier) {
        stopApmSession(startingRecorder);
        startingRecorders.delete(mode);
      }
      if (mode === 'replay' && retryAfterCrash && !disposed && isNativeChildCrash(error)) {
        await waitMs(REPLAY_CAPTURE_RETRY_DELAY_MS);
        machineInfoReady = false;
        try {
          await probeInternal();
          return startInternal(settings, mode, false);
        } catch (retryError) {
          retryError.cause = error;
          throw retryError;
        }
      }
      // Keep failure/demotion state keyed by the canonical codec and physical
      // selection. A non-display target uses a soft runtime variant internally,
      // which is not part of the machine-info encoder inventory.
      const encoderId = resolvedEncoder.encoderId;
      if (isEncoderStartRejection(error) && state.encoders.some((item) => item.type === encoderId)) {
        const failedTarget = resolvedEncoder.adapterTarget ?? resolvedAdapterTarget;
        demotedEncoders.add(encoderDemotionKey(encoderId, failedTarget));
        if (resolvedEncoder.adapterTarget && JSON.stringify(resolvedEncoder.adapterTarget) !== JSON.stringify(failedTarget)) {
          demotedEncoders.add(encoderDemotionKey(encoderId, resolvedEncoder.adapterTarget));
        }
        publish({ encoders: state.encoders.map((item) => item.type === encoderId && encoderTargetMatchesSelection(item, failedTarget)
          ? { ...item, startTested: true, startSupported: false, probeValid: false, code: error.code, status: 'start rejected' }
          : item) });
        try {
          await onEncoderDemoted(encoderId, error, {
            selectionId: settings.encoderId,
            adapterTarget: resolvedEncoder.adapterTarget ?? failedTarget,
            codec: encoderId,
          });
        } catch (persistError) {
          error.persistenceError = persistError;
          publish({ error: `Encoder was rejected, but its persisted selection could not be reset: ${persistError.message}` });
        }
      }
      throw error;
    }
    // The started event has already made the recorder active. Keep its
    // authoritative mode/timestamp and only add the successful encoder
    // validation here.
    const successfulTarget = resolvedEncoder.adapterTarget ?? resolvedAdapterTarget;
    publish({ error: null, encoders: state.encoders.map((item) => item.type === payload.video_settings.video_encoder.id && encoderTargetMatchesSelection(item, successfulTarget)
      ? { ...item, startTested: true, startSupported: true, status: 'started' }
      : item) });
    if (mode === 'replay') publishInstantReplaySave(INSTANT_REPLAY_SAVE_STATUS.READY, { updatedAt: clock() });
    return state;
  }

  async function stopInternal(requestedMode = null, options = {}) {
    if (!child) return state;
    const modes = requestedMode === 'video' || requestedMode === 'replay' ? [requestedMode] : ['video', 'replay'];
    const recorder = modes.map((mode) => activeRecorders.get(mode) ?? startingRecorders.get(mode)).find(Boolean);
    if (!recorder) return state;
    const suppressReplayState = options?.suppressReplayState === true && recorder.mode === 'replay';
    if (recorder.stopInFlight) return state;
    const wasActive = activeRecorders.get(recorder.mode)?.identifier === recorder.identifier;
    if (!wasActive && startingRecorders.get(recorder.mode)?.identifier === recorder.identifier) recorder.cancelRequested = true;
    recorder.stopInFlight = true;
    const stopEvent = recorder.type === ASCENT_RECORDER_TYPES.REPLAY ? ASCENT_EVENTS.REPLAY_STOPPED : ASCENT_EVENTS.RECORDING_STOPPED;
    try {
      await request(ASCENT_COMMANDS.STOP, recorder.type, {}, [stopEvent], 10000, recorder.identifier);
      // handleMessage clears activeRecorder as soon as STOPPED arrives, so
      // retain the pre-request identity when deciding whether the next start
      // needs a fresh OBS child.
      const stoppedActive = wasActive;
      if (stoppedActive) activeRecorders.delete(recorder.mode);
      const starting = startingRecorders.get(recorder.mode);
      if (starting?.identifier === recorder.identifier && (stoppedActive || starting.startedAfterCancel)) startingRecorders.delete(recorder.mode);
      if (stoppedActive) freshChildRequired = true;
      if (!suppressReplayState) publish(captureStatePatch());
      if (recorder.mode === 'replay' && !suppressReplayState) publishInstantReplaySave(INSTANT_REPLAY_SAVE_STATUS.IDLE, { updatedAt: clock() });
      return state;
    } finally {
      recorder.stopInFlight = false;
    }
  }

  function replayCaptureStopIdentifier(identifier = null) {
    const capture = replayCapture;
    if (capture && (identifier === null || identifier === capture.captureIdentifier || identifier === capture.bufferIdentifier)) {
      // START_REPLAY_CAPTURE uses a one-shot capture identifier, but Ascent
      // addresses STOP_REPLAY_CAPTURE and replay_ready by the rolling replay
      // buffer identifier. Sending the temporary capture id makes longer
      // captures answer "not capturing" and forces an unsafe buffer restart.
      return capture.bufferIdentifier;
    }
    return identifier;
  }

  async function stopReplayClipInternal(identifier = null) {
    const stopIdentifier = replayCaptureStopIdentifier(identifier);
    if (!Number.isSafeInteger(stopIdentifier)) throw new Error('Instant Replay capture is not active');
    return request(ASCENT_COMMANDS.STOP_REPLAY_CAPTURE, ASCENT_RECORDER_TYPES.REPLAY, {}, [ASCENT_EVENTS.REPLAY_CAPTURE_VIDEO_READY], 10000, stopIdentifier);
  }

  function replayCaptureAlreadyActive(error) {
    return /already\s+(?:capturing|started|active)|capture(?:d|)\s+is\s+already\s+active/i.test(String(error?.message ?? ''));
  }

  function replayCaptureNotReady(error) {
    return /not\s+capturing|replay(?:s)?\s+(?:is\s+)?offline|replay\s+buffer.*(?:not|isn't)\s+(?:active|ready)|not\s+active/i.test(String(error?.message ?? ''));
  }

  function waitMs(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
  }

  async function recoverReplayCapture() {
    const capture = replayCapture;
    if (!capture) return true;
    // A READY event already completed the native capture. Sending a second
    // STOP to older Ascent builds can wait until the request timeout even
    // though the replay buffer itself is healthy. Clear that completed
    // identity locally and let the next capture start normally.
    if (capture.phase === 'ready') {
      replayCapture = null;
      return true;
    }
    try {
      await stopReplayClipInternal(capture.bufferIdentifier);
      replayCapture = null;
      return true;
    } catch (error) {
      // A late recovery STOP can race with the first STOP response. Treat the
      // native "not capturing" response as the desired end state.
      if (replayCaptureNotReady(error)) {
        replayCapture = null;
        return true;
      }
      capture.phase = 'unknown';
      capture.recoveryError = error;
      publish({ error: `Replay clip recovery failed: ${error.message}` });
      return false;
    }
  }

  // A few Ascent builds can leave the private clip capture in an unknown
  // state after a mux/trim failure.  Clearing only the JavaScript marker is
  // insufficient: the next START_REPLAY_CAPTURE is then rejected as already
  // active.  Recycle the replay buffer itself so the next Save Clip starts
  // from a clean native capture session.  A manual recording keeps the
  // shared child alive; when replay is the only active mode, a failed buffer
  // stop is recovered by retiring that child and starting a fresh one.
  async function restartReplayBufferAfterCaptureFailure(settingsOverride = null) {
    const replayRecorder = activeRecorders.get('replay');
    const settings = replayRecorder?.settings ?? settingsOverride;
    if (!settings) return false;
    let restarted = false;
    replayBufferRecoveryInFlight = true;
    try {
      if (replayRecorder) await stopInternal('replay', { suppressReplayState: true });
    } catch (stopError) {
      if (activeRecorders.has('video') || startingRecorders.has('video')) {
        publish({ error: `Replay capture recovery could not stop the shared runtime: ${stopError?.message ?? String(stopError)}` });
        replayBufferRecoveryInFlight = false;
        publish(captureStatePatch());
        return false;
      }
      const target = child;
      if (target) {
        retiredChildren.add(target);
        try { target.kill(); } catch { /* best effort */ }
        if (child === target) child = null;
      }
      activeRecorders.delete('replay');
      startingRecorders.delete('replay');
      stopApmSession(replayRecorder);
      replayCapture = null;
      replayCaptureReadyAt = 0;
      freshChildRequired = false;
      closingChild = null;
      terminationStarted = false;
      machineInfoReady = false;
      const restartError = new Error(`Ascent replay buffer restarted after capture recovery failed: ${stopError?.message ?? String(stopError)}`);
      rejectPending(restartError);
      rejectQueued(restartError);
    }
    replayCapture = null;
    replayCaptureReadyAt = 0;
    try {
      await startInternal(settings, 'replay', false);
      restarted = true;
      return true;
    } catch (error) {
      publish({ error: `Instant Replay could not restart after capture finalization failed: ${error?.message ?? String(error)}` });
      return false;
    } finally {
      replayBufferRecoveryInFlight = false;
      // If recovery failed after the native stop was accepted, expose the
      // actual stopped state once the silent recovery window is over. A
      // successful restart has already published the active state.
      if (!restarted) {
        publish(captureStatePatch());
        if (!activeRecorders.has('replay')) publishInstantReplaySave(INSTANT_REPLAY_SAVE_STATUS.IDLE, { updatedAt: clock() });
      }
    }
  }

  async function waitForReplayBufferDuration(durationMs) {
    const targetMs = Math.max(0, Number(durationMs) || 0);
    if (targetMs <= 0) return true;
    const deadline = Date.now() + targetMs + 5000;
    while (Date.now() <= deadline) {
      const replay = activeRecorders.get('replay');
      const startedAt = Number(replay?.startedAt);
      if (replay && Number.isFinite(startedAt) && clock() - startedAt >= targetMs) return true;
      if (!activeRecorders.has('replay') && !startingRecorders.has('replay')) return false;
      await waitMs(Math.min(250, Math.max(25, deadline - Date.now())));
    }
    return false;
  }

  // If FFmpeg cannot read or replace the native file while ascent-obs still
  // owns it, one buffer restart releases that handle. Retry the duration
  // bound against the same completed source after the restart; this keeps the
  // first Save Clip successful instead of making the user click again.
  async function enforceReplayClipDurationWithBufferRecovery(sourcePath, headDuration, fileReady = false, destinationPath = sourcePath) {
    try {
      return await enforceReplayClipDuration(sourcePath, headDuration, fileReady, destinationPath);
    } catch (error) {
      if (!await restartReplayBufferAfterCaptureFailure()) throw error;
      return enforceReplayClipDuration(sourcePath, headDuration, true, destinationPath);
    }
  }

  async function waitForReplayFile(filePath, timeoutMs = REPLAY_FILE_WAIT_MS, stableMs = REPLAY_FILE_STABLE_MS) {
    const fileState = () => {
      try {
        const stat = fs.statSync(filePath);
        return stat.isFile() && stat.size > 0 ? { size: stat.size, modifiedMs: stat.mtimeMs } : null;
      } catch { return null; }
    };
    let previous = fileState();
    if (previous && stableMs <= 0) return true;
    if (timeoutMs <= 0) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const current = fileState();
      if (current && previous && current.size === previous.size && current.modifiedMs === previous.modifiedMs) {
        const stableUntil = Date.now() + Math.max(0, stableMs);
        while (Date.now() < stableUntil) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(50, stableUntil - Date.now())));
          const check = fileState();
          if (!check || check.size !== current.size || check.modifiedMs !== current.modifiedMs) {
            previous = check;
            break;
          }
          if (Date.now() >= stableUntil) return true;
        }
      } else {
        previous = current;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  function usableReplayFile(filePath) {
    if (typeof filePath !== 'string' || !filePath) return false;
    try {
      const stat = fs.statSync(filePath);
      return stat.isFile() && stat.size > 0;
    } catch { return false; }
  }

  function resolveReplaySourcePath({ response, nativePath, requestedPath, requestedPathExisted }) {
    const responsePath = typeof response?.path === 'string' && response.path.trim() ? response.path : null;
    const responseIsExistingRequestedPath = requestedPathExisted
      && responsePath
      && path.resolve(responsePath) === path.resolve(requestedPath);
    const candidates = [responseIsExistingRequestedPath ? null : responsePath, nativePath];
    // A few older Ascent builds ignored the private path field and wrote to
    // the requested output path. Only accept that compatibility path when it
    // did not already exist before this save, so an old clip can never be
    // mistaken for the new replay source.
    if (!requestedPathExisted) candidates.push(requestedPath);
    return candidates.find((candidate) => usableReplayFile(candidate)) ?? nativePath;
  }

  function discardReplayClip(filePath) {
    if (typeof filePath !== 'string' || !filePath) return null;
    try {
      fs.rmSync(filePath, { force: true });
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  async function discardReplayClipAfterFailure(filePath) {
    if (typeof filePath !== 'string' || !filePath) return null;
    const deadline = Date.now() + REPLAY_FILE_CLEANUP_WAIT_MS;
    let lastError = null;
    // Recovery STOP can release a partial file after its response has already
    // rejected. Keep retrying through that short window so a late-created
    // output cannot survive a failed save.
    while (Date.now() <= deadline) {
      const removeError = discardReplayClip(filePath);
      if (removeError) lastError = removeError;
      try {
        if (fs.existsSync(filePath)) {
          // A successful rmSync should make this false; keep retrying when a
          // native handle temporarily prevents deletion.
          if (!removeError) lastError = new Error('Replay clip still exists after cleanup');
        } else if (!removeError) lastError = null;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const finalError = discardReplayClip(filePath);
    if (finalError) lastError = finalError;
    try {
      if (fs.existsSync(filePath)) lastError = lastError ?? new Error('Replay clip still exists after cleanup');
      else if (!finalError) lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    return lastError;
  }

  async function boundReplayClip(sourcePath, headDuration, fileReady = false, destinationPath = sourcePath) {
    if (typeof trimReplayClip !== 'function') return false;
    // Re-check stability on every attempt. `replay_ready` can arrive while
    // the native muxer is still extending the file, and trimming that moving
    // source is how an entire rolling buffer escaped as a short clip.
    if (!await waitForReplayFile(sourcePath, fileReady ? REPLAY_FILE_STABLE_MS * 3 : REPLAY_FILE_WAIT_MS)) return false;
    try {
      const result = await trimReplayClip({ path: sourcePath, destinationPath, durationMs: headDuration });
      if (result === true) return destinationPath;
      if (result && typeof result.path === 'string' && result.path.trim()) return result.path;
      return false;
    } catch {
      return false;
    }
  }

  async function enforceReplayClipDuration(sourcePath, headDuration, fileReady = false, destinationPath = sourcePath) {
    if (typeof trimReplayClip !== 'function') return;
    // The runtime can keep the native output handle open well after the
    // replay-ready event. Retry the bounded copy while that handle drains;
    // never publish the original rolling file as if it were bounded.
    const deadline = Date.now() + Math.max(0, Number(replayTrimRetryMs) || 0);
    let firstAttempt = true;
    while (Date.now() <= deadline) {
      const attempt = await boundReplayClip(sourcePath, headDuration, fileReady || !firstAttempt, destinationPath);
      firstAttempt = false;
      if (attempt) return attempt;
      if (Date.now() >= deadline) break;
      await waitMs(REPLAY_CAPTURE_RETRY_DELAY_MS);
    }
    const error = new Error('Replay clip could not be limited to the requested duration');
    error.code = 'REPLAY_CLIP_DURATION_FAILED';
    throw error;
  }

  async function startReplayCaptureWithRetry({ clipPath, durationMs, thumbnailFolder, bufferIdentifier, captureIdentifier }) {
    const deadline = Date.now() + REPLAY_CAPTURE_RETRY_MS;
    let lastError = null;
    while (Date.now() <= deadline) {
      replayCapture = { bufferIdentifier, captureIdentifier, phase: 'starting' };
      try {
        const captureStartTimeout = replayCaptureReadyAt > 0 ? 3000 : 10000;
        await request(ASCENT_COMMANDS.START_REPLAY_CAPTURE, ASCENT_RECORDER_TYPES.REPLAY, {
          path: clipPath,
          head_duration: Math.round(durationMs),
          thumbnail_folder: thumbnailFolder,
        }, [ASCENT_EVENTS.REPLAY_CAPTURE_VIDEO_STARTED], captureStartTimeout, captureIdentifier);
        replayCapture.phase = 'capturing';
        replayCaptureReadyAt = 0;
        return;
      } catch (error) {
        lastError = error;
        const recentReplayFinalization = Number.isFinite(replayCaptureReadyAt)
          && replayCaptureReadyAt > 0
          && clock() - replayCaptureReadyAt <= REPLAY_CAPTURE_RETRY_MS;
        const transient = replayCaptureAlreadyActive(error)
          || replayCaptureNotReady(error)
          || (error?.code === 'ASCENT_TIMEOUT' && recentReplayFinalization);
        if (!transient || Date.now() >= deadline) throw error;
        // If an earlier save left the native muxer in its capture state, one
        // recovery STOP clears that state. A not-ready buffer simply gets a
        // short retry while its first keyframe/armed signal arrives.
        if (replayCaptureAlreadyActive(error)) {
          try { await stopReplayClipInternal(replayCapture?.bufferIdentifier); } catch { /* retry below */ }
        }
        replayCapture = null;
        await waitMs(REPLAY_CAPTURE_RETRY_DELAY_MS);
      }
    }
    throw lastError ?? new Error('Instant Replay capture did not become ready');
  }

  function replayReadyPayload(response, activeReplay, clipPath, thumbnailFolder, requestedDurationMs) {
    const sourceSessionId = typeof response?.sourceSessionId === 'string' && response.sourceSessionId.trim()
      ? response.sourceSessionId.trim()
      : activeReplay?.sessionId ?? null;
    const nativeDuration = Number.isFinite(response?.durationMs)
      ? Math.max(0, Math.round(response.durationMs))
      : Number.isFinite(response?.duration)
        ? Math.max(0, Math.round(response.duration))
        : null;
    const replayStartedAt = Number(activeReplay?.startedAt);
    const nativeVideoStart = Number.isFinite(response?.video_start_time) && Number.isFinite(replayStartedAt)
      ? Math.max(0, Math.round(response.video_start_time - replayStartedAt))
      : null;
    const nativeStart = Number.isFinite(response?.sourceStartMs)
      ? Math.max(0, Math.round(response.sourceStartMs))
      : nativeVideoStart;
    const nativeEnd = Number.isFinite(response?.sourceEndMs)
      ? Math.max(0, Math.round(response.sourceEndMs))
      : nativeStart !== null && nativeDuration !== null
        ? nativeStart + nativeDuration
        : null;
    const elapsedNow = Math.max(0, Math.round(clock() - Number(activeReplay?.startedAt ?? clock())));
    const requested = Math.max(1, Math.round(requestedDurationMs ?? nativeDuration ?? 1));
    // Older runtime builds have returned wall-clock timestamps (or a stale
    // zero interval) in sourceStartMs/sourceEndMs.  Those values cannot be
    // matched to the session-local APM timeline. Treat them as absent when
    // they fall outside the active replay's elapsed range and use the same
    // session-relative interval as markers.
    const nativeIntervalValid = nativeStart !== null && nativeEnd !== null
      && nativeEnd >= nativeStart
      && nativeStart <= elapsedNow + 5000
      && nativeEnd <= elapsedNow + 5000
      && (nativeEnd > nativeStart || elapsedNow < 1000)
      && (nativeEnd - nativeStart) <= requested + 5000
      && (nativeDuration === null || Math.abs((nativeEnd - nativeStart) - nativeDuration) <= 5000);
    const nativeIntervalDuration = nativeIntervalValid ? Math.max(1, nativeEnd - nativeStart) : 0;
    // The native request includes a keyframe lead-in so the bounded output can
    // contain the full user duration. Map APM to that published tail rather
    // than the private lead-in, which otherwise shifts the activity window.
    const duration = nativeIntervalValid
      ? Math.min(requested, nativeIntervalDuration)
      : Math.min(requested, Math.max(1, elapsedNow || requested));
    const end = nativeIntervalValid ? nativeEnd : Math.max(duration, elapsedNow);
    const start = nativeIntervalValid ? Math.max(nativeStart, end - duration) : Math.max(0, end - duration);
    const apm = apmCapture?.getInterval?.(activeReplay?.sessionId, start, end) ?? null;
    return {
      ...response,
      event: 'replay_ready',
      type: 'replay_ready',
      nativeEvent: response?.event ?? ASCENT_EVENTS.REPLAY_CAPTURE_VIDEO_READY,
      sessionId: sourceSessionId,
      sourceSessionId,
      identifier: response?.identifier ?? activeReplay?.identifier ?? null,
      // The bounded path is authoritative when the original native output
      // was still locked and the trim helper published a sibling fallback.
      path: clipPath,
      durationMs: Math.max(0, end - start),
      sourceStartMs: start,
      sourceEndMs: end,
      thumbnailFolder: response?.thumbnailFolder ?? thumbnailFolder ?? null,
      ...(apm?.samples?.length ? { apmSamples: apm.samples, apmAverage: apm.averageApm, apmPeak: apm.peakApm } : {}),
      ...(typeof apm?.available === 'boolean' ? { apmAvailable: apm.available } : {}),
    };
  }

  async function saveReplayClipInternal({ path: initialClipPath, headDuration, thumbnailFolder }, recoveryAttempt = 0) {
    let clipPath = initialClipPath;
    let nativeClipPath = initialClipPath;
    let replaySourcePath = initialClipPath;
    const initialClipExisted = usableReplayFile(initialClipPath);
    let activeReplay = activeRecorders.get('replay');
    const publishSaveError = (error) => {
      publishInstantReplaySave(INSTANT_REPLAY_SAVE_STATUS.ERROR, {
        error: error instanceof Error ? error.message : String(error),
        updatedAt: clock(),
      });
      return error;
    };
    if (!activeReplay || activeReplay.type !== ASCENT_RECORDER_TYPES.REPLAY) {
      throw publishSaveError(new Error('Start Instant Replay before saving a moment'));
    }
    const durationMs = Number(headDuration);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw publishSaveError(new Error('Instant Replay duration must be greater than zero'));
    }
    if (replayCapture && !(await recoverReplayCapture())) {
      if (!(await restartReplayBufferAfterCaptureFailure())) {
        throw publishSaveError(new Error('An Instant Replay save is still being finalized; stop and restart Instant Replay before trying again'));
      }
      activeReplay = activeRecorders.get('replay');
      if (!activeReplay || activeReplay.type !== ASCENT_RECORDER_TYPES.REPLAY) {
        throw publishSaveError(new Error('Instant Replay restarted, but its buffer is not active yet'));
      }
    }
    const bufferIdentifier = activeReplay.identifier;
    const captureIdentifier = nextIdentifier++;
    // Ascent keeps the native replay output open for a short period after its
    // ready event. Capture into a private source path and publish only the
    // separately written, duration-verified destination. This removes the
    // first-save EBUSY race where replacing the native file failed and the
    // rolling/unbounded source was accidentally surfaced as the clip.
    nativeClipPath = `${initialClipPath}.arc-native-${captureIdentifier}.mp4`;
    publishInstantReplaySave(INSTANT_REPLAY_SAVE_STATUS.SAVING, { updatedAt: clock() });
    try {
      await startReplayCaptureWithRetry({
        clipPath: nativeClipPath,
        durationMs: replayCaptureDurationMsOf(durationMs, activeReplay?.settings?.replayLengthSec),
        thumbnailFolder,
        bufferIdentifier,
        captureIdentifier,
      });
      // Ascent acknowledges START_REPLAY_CAPTURE before writing the file. The
      // file is only usable after STOP_REPLAY_CAPTURE causes replay_ready.
      await waitMs(REPLAY_CAPTURE_START_SETTLE_MS);
      const response = await stopReplayClipInternal(bufferIdentifier);
      replaySourcePath = resolveReplaySourcePath({ response, nativePath: nativeClipPath, requestedPath: initialClipPath, requestedPathExisted: initialClipExisted });
      // The native replay output can include the previous keyframe/PTS lead-in
      // even when the requested head duration is shorter. Bound the completed
      // file to the requested tail after the runtime has released it.
      const boundedClipPath = await enforceReplayClipDurationWithBufferRecovery(replaySourcePath, durationMs, false, initialClipPath);
      if (typeof trimReplayClip === 'function' && !boundedClipPath) throw new Error('replay clip could not be bounded to the requested duration');
      const refreshedReplay = activeRecorders.get('replay');
      if (refreshedReplay?.type === ASCENT_RECORDER_TYPES.REPLAY) activeReplay = refreshedReplay;
      clipPath = boundedClipPath || initialClipPath;
      replayCapture = null;
      // The bounded destination is now authoritative. Source cleanup is
      // best-effort because the native muxer may still hold its handle.
      if (replaySourcePath !== clipPath) void discardReplayClipAfterFailure(replaySourcePath);
      publishInstantReplaySave(INSTANT_REPLAY_SAVE_STATUS.READY, { outputPath: clipPath, updatedAt: clock() });
      return replayReadyPayload(response, activeReplay, clipPath, thumbnailFolder, durationMs);
    } catch (error) {
      // Some runtime builds finalize the file and then emit a second
      // "not capturing" response while the replay output is closing. A
      // completed file is authoritative: do not issue another STOP, which
      // would only create another misleading error and could disturb the
      // still-running replay buffer.
      replaySourcePath = resolveReplaySourcePath({ nativePath: nativeClipPath, requestedPath: initialClipPath, requestedPathExisted: initialClipExisted });
      let completedReplayFile = typeof trimReplayClip === 'function'
        ? await waitForReplayFile(replaySourcePath, REPLAY_FILE_WAIT_MS)
        : (() => {
          return usableReplayFile(replaySourcePath);
        })();
      if (!completedReplayFile && replaySourcePath !== initialClipPath && !initialClipExisted && usableReplayFile(initialClipPath)) {
        replaySourcePath = initialClipPath;
        completedReplayFile = true;
      }
      // A long replay capture can race Ascent's private muxer: the runtime
      // accepts START_REPLAY_CAPTURE, then answers STOP with "not capturing"
      // before it has produced a file. Recycle the rolling buffer and retry
      // the same requested duration once. This keeps 30-second saves as
      // reliable as shorter saves without asking the user to restart Replay.
      if (!completedReplayFile
        && recoveryAttempt === 0
        && replayCaptureNotReady(error)
        && (activeRecorders.has('replay') || activeReplay?.settings)) {
        const recovered = await restartReplayBufferAfterCaptureFailure(activeReplay?.settings ?? null);
        if (recovered) {
          await waitForReplayBufferDuration(durationMs);
          void discardReplayClipAfterFailure(nativeClipPath);
          return saveReplayClipInternal({ path: initialClipPath, headDuration, thumbnailFolder }, recoveryAttempt + 1);
        }
      }
      if (replayCapture?.bufferIdentifier === bufferIdentifier
        && (replayCapture.phase === 'capturing' || replayCapture.phase === 'ready')
        && completedReplayFile) {
        // Some runtime builds write the clip and then report a secondary
        // "not capturing" error. That file is still authoritative, but it
        // must go through the same duration bound as the normal success path.
        try {
          const boundedClipPath = await enforceReplayClipDurationWithBufferRecovery(replaySourcePath, durationMs, true, initialClipPath);
          if (typeof trimReplayClip === 'function' && !boundedClipPath) throw new Error('replay clip could not be bounded to the requested duration');
          const refreshedReplay = activeRecorders.get('replay');
          if (refreshedReplay?.type === ASCENT_RECORDER_TYPES.REPLAY) activeReplay = refreshedReplay;
          clipPath = boundedClipPath || initialClipPath;
          replayCapture = null;
          if (replaySourcePath !== clipPath) void discardReplayClipAfterFailure(replaySourcePath);
          publish({ error: null });
          publishInstantReplaySave(INSTANT_REPLAY_SAVE_STATUS.READY, { outputPath: clipPath, updatedAt: clock() });
          return replayReadyPayload({ event: ASCENT_EVENTS.REPLAY_CAPTURE_VIDEO_READY, identifier: bufferIdentifier, path: clipPath }, activeReplay, clipPath, thumbnailFolder, durationMs);
        } catch (authoritativeError) {
          // Duration bounding failed, so this is a terminal failure after
          // the authoritative branch was attempted. Let the common cleanup
          // path remove any remaining output and preserve the failure state.
          error = authoritativeError;
        }
      }
      // Once START_REPLAY_CAPTURE was accepted, recover any capture that did
      // not reach replay_ready. A stale backend capture is otherwise likely
      // to reject the next Save Clip as "already capturing". A capture that
      // already reached replay_ready is cleared locally instead, because a
      // duplicate STOP can hang older Ascent builds.
      if (replayCapture?.bufferIdentifier === bufferIdentifier && (replayCapture.phase !== 'starting' || replayCaptureAlreadyActive(error))) {
        const recovered = await recoverReplayCapture();
        if (!recovered) await restartReplayBufferAfterCaptureFailure();
      } else {
        replayCapture = null;
      }
      const cleanupErrors = [];
      for (const candidate of new Set([nativeClipPath, replaySourcePath, clipPath])) {
        const internalSource = candidate === nativeClipPath || (candidate === replaySourcePath && replaySourcePath !== clipPath);
        if (internalSource) {
          // Internal Ascent sources may remain locked until the muxer drains;
          // cleanup must not hold the user-facing failure on that handle.
          void discardReplayClipAfterFailure(candidate);
          continue;
        }
        const cleanupError = await discardReplayClipAfterFailure(candidate);
        if (cleanupError) cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        const originalError = error instanceof Error ? error : new Error(String(error));
        const reportedError = new Error(`${originalError.message}; replay clip cleanup failed: ${cleanupErrors.map((item) => item.message).join('; ')}`);
        reportedError.code = 'REPLAY_CLIP_CLEANUP_FAILED';
        reportedError.cause = originalError;
        error = reportedError;
      }
      publishInstantReplaySave(INSTANT_REPLAY_SAVE_STATUS.ERROR, {
        error: error instanceof Error ? error.message : String(error),
        updatedAt: clock(),
      });
      throw error;
    }
  }

  async function shutdownInternal() {
    disposed = true;
    if (!child) return state;
    if (state.running || startingRecorders.size > 0) {
      try { await Promise.race([stopInternal(), new Promise((resolve) => setTimeout(resolve, shutdownMs))]); } catch { /* kill fallback below */ }
    }
    await closeChildGracefully();
    freshChildRequired = false;
    activeRecorders.clear();
    startingRecorders.clear();
    replayCapture = null;
    replayCaptureReadyAt = 0;
    try { apmCapture?.dispose?.(); } catch { /* best effort */ }
    rejectPending(new Error('Ascent engine shut down'));
    rejectQueued(new Error('Ascent engine shut down'));
    return state;
  }

  return {
    getState: () => ({ ...state, available: state.available, encoders: state.encoders.map((item) => ({ ...item })), audioInputs: state.audioInputs.map((item) => ({ ...item })), audioOutputs: state.audioOutputs.map((item) => ({ ...item })) }),
    probe: () => serialize(probeInternal),
    startRecording: (settings) => serialize(() => startInternal(settings, 'video')),
    startReplay: (settings) => serialize(() => startInternal(settings, 'replay')),
    stop: (mode = null) => serialize(() => stopInternal(mode)),
    takeCompletedCapture: (mode = 'video') => {
      const index = completedCaptures.findIndex((item) => !mode || item.mode === mode);
      if (index < 0) return null;
      return completedCaptures.splice(index, 1)[0] ?? null;
    },
    saveReplayClip: (settings) => {
      if (replayClipSaveInFlight) {
        const error = new Error('Instant Replay is already being saved');
        error.code = 'INSTANT_REPLAY_SAVE_IN_PROGRESS';
        return Promise.reject(error);
      }
      replayClipSaveInFlight = true;
      const operation = serialize(() => saveReplayClipInternal(settings));
      return operation.finally(() => { replayClipSaveInFlight = false; });
    },
    stopReplayClip: (identifier) => serialize(() => stopReplayClipInternal(identifier)),
    shutdown: () => serialize(shutdownInternal),
    subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  };
}
