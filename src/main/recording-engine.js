import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { spawn as spawnProcess } from 'node:child_process';
import { consumeAscentJsonObjects, ASCENT_MAX_MESSAGE_BYTES, RECORDING_RESOLUTIONS, resolveRecordingRuntimeCandidates } from './recording-pure.js';

export const ASCENT_COMMANDS = Object.freeze({ SHUTDOWN: 1, QUERY_MACHINE_INFO: 2, START: 3, STOP: 4, START_REPLAY_CAPTURE: 8, STOP_REPLAY_CAPTURE: 9, SPLIT_VIDEO: 12 });
export const ASCENT_RECORDER_TYPES = Object.freeze({ VIDEO: 1, REPLAY: 2, STREAMING: 3 });
export const ASCENT_EVENTS = Object.freeze({ QUERY_MACHINE_INFO: 1, ERR: 2, READY: 3, RECORDING_STARTED: 4, RECORDING_STOPPING: 5, RECORDING_STOPPED: 6, VIDEO_FILE_SPLIT: 8, REPLAY_STARTED: 9, REPLAY_STOPPING: 10, REPLAY_STOPPED: 11, REPLAY_ARMED: 12, REPLAY_CAPTURE_VIDEO_STARTED: 13, REPLAY_CAPTURE_VIDEO_READY: 14, REPLAY_ERROR: 15 });
export const ASCENT_ENCODER_START_ERROR_CODES = Object.freeze([-6, -8]);
export const ASCENT_QSV_ENCODER_PREFERENCE = Object.freeze(['obs_qsv11_v2', 'obs_qsv11_hevc', 'obs_qsv11_av1']);
const DEFAULT_SHUTDOWN_MS = 1500;

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

function resolutionOf(id) { return RECORDING_RESOLUTIONS.find((item) => item.id === id) ?? RECORDING_RESOLUTIONS.find((item) => item.id === '1080p'); }

function isUsableEncoder(encoder) {
  return encoder?.enumerated === true && encoder.probeValid === true && encoder.startSupported === true;
}

function unsupportedEncoderError(requested, encoders) {
  const available = (Array.isArray(encoders) ? encoders : []).filter(isUsableEncoder).map((encoder) => encoder.type);
  const suffix = available.length ? ` Usable encoders: ${available.join(', ')}.` : ' The runtime did not report a usable Intel QSV encoder.';
  const error = new Error(requested === 'automatic'
    ? `No usable Intel QSV encoder is available from the Ascent runtime. Run Check Runtime and select a valid H264, HEVC, or AV1 encoder.${suffix}`
    : `Encoder '${requested}' is not valid or start-supported by the current Ascent runtime. Run Check Runtime and select a valid H264, HEVC, or AV1 encoder.${suffix}`);
  error.code = 'UNSUPPORTED_ENCODER';
  return error;
}

export function resolveRecordingEncoder(requested, encoders) {
  const usable = (Array.isArray(encoders) ? encoders : []).filter(isUsableEncoder);
  if (requested === 'automatic') {
    const selected = ASCENT_QSV_ENCODER_PREFERENCE.find((id) => usable.some((encoder) => encoder.type === id));
    if (selected) return selected;
    throw unsupportedEncoderError(requested, encoders);
  }
  if (!ASCENT_QSV_ENCODER_PREFERENCE.includes(requested) || !usable.some((encoder) => encoder.type === requested)) {
    throw unsupportedEncoderError(requested, encoders);
  }
  return requested;
}

export function buildAscentStartPayload(settings, outputPath, recorderType = ASCENT_RECORDER_TYPES.VIDEO, identifier = 0) {
  const resolution = resolutionOf(settings.resolution);
  const encoderId = settings.encoderId;
  return buildAscentCommand(ASCENT_COMMANDS.START, identifier, recorderType, {
    sources: { monitor: { enable: true, force: false, cursor: false, monitor_handle: 0 } },
    video_settings: {
      fps: settings.fps,
      base_width: resolution.width || 1920,
      base_height: resolution.height || 1080,
      output_width: resolution.width || 1920,
      output_height: resolution.height || 1080,
      video_encoder: { id: encoderId, preset: 'automatic', rate_control: 'CBR', bitrate: settings.bitrateKbps },
    },
    audio_settings: { sample_rate: 48000, mono: false, input: {}, output: {} },
    file_output: { filename: outputPath, format: 'mp4', max_file_size_bytes: 0, enbale_on_demand_spilt_video: false, include_full_video: true },
    ...(recorderType === ASCENT_RECORDER_TYPES.REPLAY ? { replay: { max_time_sec: settings.replayLengthSec } } : {}),
  });
}

function isEncoderStartRejection(error) {
  return Number.isInteger(error?.code) && ASCENT_ENCODER_START_ERROR_CODES.includes(error.code);
}

export function createAscentEngine({ runtimeResolver = resolveAscentRuntime, spawn = spawnProcess, clock = () => Date.now(), onState = () => {}, onEncoderDemoted = async () => {}, shutdownMs = DEFAULT_SHUTDOWN_MS } = {}) {
  let child = null;
  let output = '';
  let decoder = new StringDecoder('utf8');
  let nextIdentifier = 1;
  let disposed = false;
  let protocolFailure = null;
  let terminationStarted = false;
  let activeRecorder = null;
  let captureInFlight = false;
  const demotedEncoders = new Set();
  let state = { available: false, running: false, mode: null, error: null, encoders: [], lastEvent: null };
  const listeners = new Set();
  const pending = new Map();
  const writeQueue = [];
  let writing = false;

  const publish = (patch) => {
    state = { ...state, ...patch };
    onState(state);
    for (const cb of listeners) cb(state);
  };

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
    publish({ available: false, running: false, mode: null, error: `Ascent protocol error: ${failure.message}` });
    rejectPending(failure);
    rejectQueued(failure);
    terminateChild();
  }

  function handleMessage(message) {
    const event = Number.isInteger(message?.event) ? message.event : null;
    if (event === null) return;
    const identifier = Number.isInteger(message.identifier) ? message.identifier : null;
    const stopped = event === ASCENT_EVENTS.RECORDING_STOPPED || event === ASCENT_EVENTS.REPLAY_STOPPED;
    if (stopped && (!activeRecorder || identifier === null || identifier === activeRecorder.identifier)) activeRecorder = null;
    publish({
      lastEvent: { ...message, at: clock() },
      ...(event === ASCENT_EVENTS.RECORDING_STARTED || event === ASCENT_EVENTS.REPLAY_STARTED ? { running: true } : {}),
      ...(stopped ? { running: false, mode: null } : {}),
    });
    const waiter = identifier === null ? null : pending.get(identifier);
    if (!waiter) return;
    if (event === ASCENT_EVENTS.ERR || event === ASCENT_EVENTS.REPLAY_ERROR) {
      pending.delete(identifier);
      clearTimeout(waiter.timer);
      const commandError = new Error(message.desc || `Ascent command failed (${message.code ?? 'unknown'})`);
      if (Number.isInteger(message.code)) commandError.code = message.code;
      commandError.event = event;
      waiter.reject(commandError);
      return;
    }
    if (waiter.events.includes(event)) {
      pending.delete(identifier);
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
    const runtime = runtimeResolver();
    if (!runtime) {
      publish({ available: false, error: 'Ascent runtime is not provisioned' });
      throw new Error('Ascent runtime is not provisioned');
    }
    terminationStarted = false;
    protocolFailure = null;
    child = spawn(runtime.executable, [], { cwd: runtime.root, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    output = '';
    decoder = new StringDecoder('utf8');
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', (chunk) => publish({ error: chunk.toString('utf8').trim().slice(0, 512) }));
    child.on('error', (error) => {
      publish({ available: false, running: false, mode: null, error: error.message });
      rejectPending(error);
      rejectQueued(error);
    });
    child.on('exit', (code, signal) => {
      const failure = protocolFailure;
      child = null;
      activeRecorder = null;
      captureInFlight = false;
      terminationStarted = false;
      publish({ available: false, running: false, mode: null, error: failure ? `Ascent protocol error: ${failure.message}` : disposed ? null : `Ascent exited (${code ?? signal ?? 'unknown'})` });
      rejectPending(failure ?? new Error('Ascent process exited'));
      rejectQueued(failure ?? new Error('Ascent process exited'));
      protocolFailure = null;
    });
    publish({ available: true, error: null });
    return child;
  }

  function request(command, recorderType, fields, events, timeoutMs = 5000, requestedIdentifier = null) {
    ensureChild();
    const identifier = Number.isSafeInteger(requestedIdentifier) ? requestedIdentifier : nextIdentifier++;
    const full = buildAscentCommand(command, identifier, recorderType, fields);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(identifier); reject(new Error('Timed out waiting for Ascent')); }, timeoutMs);
      pending.set(identifier, { resolve, reject, timer, events });
      try {
        enqueue(full).catch((error) => { pending.delete(identifier); clearTimeout(timer); reject(error); });
      } catch (error) {
        pending.delete(identifier);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async function probe() {
    const response = await request(ASCENT_COMMANDS.QUERY_MACHINE_INFO, ASCENT_RECORDER_TYPES.VIDEO, {}, [ASCENT_EVENTS.QUERY_MACHINE_INFO]);
    const encoders = Array.isArray(response.vid_encs) ? response.vid_encs.map((encoder) => {
      const type = String(encoder.type ?? '');
      const demoted = demotedEncoders.has(type);
      const valid = encoder.valid === true;
      return { ...encoder, type, enumerated: true, probeValid: valid && !demoted, startTested: demoted, startSupported: valid && !demoted, code: demoted ? -8 : null, status: demoted ? 'start rejected' : valid ? '' : 'invalid' };
    }) : [];
    publish({ encoders });
    return { ...state, encoders };
  }

  async function start(settings, mode = 'video') {
    if (activeRecorder || state.running) throw new Error('Ascent recorder is already active');
    await probe();
    const outputPath = settings.outputPath;
    const type = mode === 'replay' ? ASCENT_RECORDER_TYPES.REPLAY : ASCENT_RECORDER_TYPES.VIDEO;
    const selectedEncoder = demotedEncoders.has(settings.encoderId) ? 'automatic' : settings.encoderId;
    const encoderId = resolveRecordingEncoder(selectedEncoder, state.encoders);
    const payload = buildAscentStartPayload({ ...settings, encoderId }, outputPath, type);
    const identifier = nextIdentifier++;
    const fields = Object.fromEntries(Object.entries(payload).filter(([key]) => !['cmd', 'identifier', 'recorder_type'].includes(key)));
    try {
      await request(payload.cmd, type, fields, [ASCENT_EVENTS.READY, ASCENT_EVENTS.RECORDING_STARTED, ASCENT_EVENTS.REPLAY_STARTED], 15000, identifier);
    } catch (error) {
      const encoderId = payload.video_settings.video_encoder.id;
      if (isEncoderStartRejection(error) && state.encoders.some((item) => item.type === encoderId)) {
        demotedEncoders.add(encoderId);
        publish({ encoders: state.encoders.map((item) => item.type === encoderId ? { ...item, startTested: true, startSupported: false, probeValid: false, code: error.code, status: 'start rejected' } : item) });
        try {
          await onEncoderDemoted(encoderId, error);
        } catch (persistError) {
          error.persistenceError = persistError;
          publish({ error: `Encoder was rejected, but its persisted selection could not be reset: ${persistError.message}` });
        }
      }
      throw error;
    }
    activeRecorder = { identifier, type };
    publish({ running: true, mode, error: null, encoders: state.encoders.map((item) => item.type === payload.video_settings.video_encoder.id ? { ...item, startTested: true, startSupported: true, status: 'started' } : item) });
    return state;
  }

  async function stop() {
    if (!child || !state.running || !activeRecorder) return state;
    const recorder = activeRecorder;
    const stopEvent = recorder.type === ASCENT_RECORDER_TYPES.REPLAY ? ASCENT_EVENTS.REPLAY_STOPPED : ASCENT_EVENTS.RECORDING_STOPPED;
    await request(ASCENT_COMMANDS.STOP, recorder.type, {}, [stopEvent], 10000, recorder.identifier);
    activeRecorder = null;
    publish({ running: false, mode: null });
    return state;
  }

  async function stopReplayClip(identifier = activeRecorder?.identifier) {
    if (!Number.isSafeInteger(identifier)) throw new Error('Replay buffer is not active');
    return request(ASCENT_COMMANDS.STOP_REPLAY_CAPTURE, ASCENT_RECORDER_TYPES.REPLAY, {}, [ASCENT_EVENTS.REPLAY_CAPTURE_VIDEO_READY], 10000, identifier);
  }

  async function saveReplayClip({ path: clipPath, headDuration, thumbnailFolder }) {
    if (!activeRecorder || activeRecorder.type !== ASCENT_RECORDER_TYPES.REPLAY) throw new Error('Start the replay buffer before saving a clip');
    if (captureInFlight) throw new Error('A replay clip is already being finalized');
    captureInFlight = true;
    const captureIdentifier = nextIdentifier++;
    try {
      await request(ASCENT_COMMANDS.START_REPLAY_CAPTURE, ASCENT_RECORDER_TYPES.REPLAY, { path: clipPath, head_duration: Math.max(0, Math.round(headDuration)), thumbnail_folder: thumbnailFolder }, [ASCENT_EVENTS.REPLAY_CAPTURE_VIDEO_STARTED], 10000, captureIdentifier);
      // Ascent acknowledges START_REPLAY_CAPTURE before writing the file. The
      // file is only usable after STOP_REPLAY_CAPTURE causes replay_ready.
      return await stopReplayClip(activeRecorder.identifier);
    } finally {
      captureInFlight = false;
    }
  }

  async function shutdown() {
    disposed = true;
    if (!child) return state;
    if (state.running) {
      try { await Promise.race([stop(), new Promise((resolve) => setTimeout(resolve, shutdownMs))]); } catch { /* kill fallback below */ }
    }
    const shutdownTarget = child;
    try { await enqueue(buildAscentCommand(ASCENT_COMMANDS.SHUTDOWN, nextIdentifier++, ASCENT_RECORDER_TYPES.VIDEO)); } catch { /* kill fallback below */ }
    await new Promise((resolve) => {
      if (!shutdownTarget || shutdownTarget.exitCode !== null) return resolve();
      const timer = setTimeout(() => { try { shutdownTarget.kill(); } catch {} resolve(); }, shutdownMs);
      shutdownTarget.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    child = null;
    activeRecorder = null;
    rejectPending(new Error('Ascent engine shut down'));
    rejectQueued(new Error('Ascent engine shut down'));
    return state;
  }

  return {
    getState: () => ({ ...state, available: state.available, encoders: state.encoders.map((item) => ({ ...item })) }),
    probe,
    startRecording: (settings) => start(settings, 'video'),
    startReplay: (settings) => start(settings, 'replay'),
    stop,
    saveReplayClip,
    stopReplayClip,
    shutdown,
    subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  };
}
