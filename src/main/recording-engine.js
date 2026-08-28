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

function resolutionOf(id) { return RECORDING_RESOLUTIONS.find((item) => item.id === id) ?? RECORDING_RESOLUTIONS.find((item) => item.id === '1080p'); }

function isUsableEncoder(encoder) {
  return encoder?.enumerated === true && encoder.probeValid === true && encoder.startSupported === true;
}

function unsupportedEncoderError(requested, encoders) {
  const available = (Array.isArray(encoders) ? encoders : []).filter(isUsableEncoder).map((encoder) => encoder.type);
  const suffix = available.length ? ` Usable encoders: ${available.join(', ')}.` : ' The runtime did not report a usable Intel QSV encoder.';
  const error = new Error(requested === 'automatic'
    ? `No usable Intel QSV encoder is available from the bundled ascent-obs runtime. Select a valid H264, HEVC, or AV1 encoder.${suffix}`
    : `Encoder '${requested}' is not valid or start-supported by the bundled ascent-obs runtime. Select a valid H264, HEVC, or AV1 encoder.${suffix}`);
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

export function createAscentEngine({ runtimeResolver = resolveAscentRuntime, spawn = spawnProcess, clock = () => Date.now(), onState = () => {}, onEncoderDemoted = async () => {}, shutdownMs = DEFAULT_SHUTDOWN_MS, startTimeoutMs = 15000 } = {}) {
  let child = null;
  let output = '';
  let decoder = new StringDecoder('utf8');
  let nextIdentifier = 1;
  let disposed = false;
  let protocolFailure = null;
  let terminationStarted = false;
  let activeRecorder = null;
  let startingRecorder = null;
  let replayCapture = null;
  const demotedEncoders = new Set();
  let state = { available: false, running: false, mode: null, startedAt: null, error: null, encoders: [], lastEvent: null };
  const listeners = new Set();
  const pending = new Map();
  const writeQueue = [];
  let writing = false;
  let lifecycle = Promise.resolve();

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
    publish({ available: false, running: false, mode: null, startedAt: null, error: `Ascent protocol error: ${failure.message}` });
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
    if (event === ASCENT_EVENTS.READY && startingRecorder && (identifier === null || identifier === startingRecorder.identifier)) {
      startingRecorder.ready = true;
    }
    const recorderForEvent = activeRecorder && (identifier === null || identifier === activeRecorder.identifier)
      ? activeRecorder
      : startingRecorder && (identifier === null || identifier === startingRecorder.identifier)
        ? startingRecorder
        : null;
    if (started && recorderForEvent) {
      activeRecorder = { ...recorderForEvent };
      if (recorderForEvent.cancelRequested) {
        recorderForEvent.startedAfterCancel = true;
        if (!recorderForEvent.stopInFlight) {
          void stopInternal().catch((error) => {
            // Keep activeRecorder intact when recovery fails so the user can
            // retry Stop. Surface the backend failure instead of creating an
            // unhandled rejection from this event-driven recovery path.
            publish({ error: `The recording started after cancellation and could not be stopped automatically: ${error?.message ?? String(error)}. Stop recording manually.` });
          });
        }
      } else {
        startingRecorder = null;
      }
    }
    if (event === ASCENT_EVENTS.REPLAY_CAPTURE_VIDEO_READY && replayCapture?.bufferIdentifier === identifier) replayCapture = null;
    if (event === ASCENT_EVENTS.REPLAY_STOPPED) replayCapture = null;
    if (stopped && (!activeRecorder || identifier === null || identifier === activeRecorder.identifier)) {
      const stoppedActive = activeRecorder;
      activeRecorder = null;
      if (identifier === null || !startingRecorder || identifier === startingRecorder.identifier) {
        // Keep a timed-out/cancel-requested pending start until it has either
        // produced STARTED or the child exits. A STOPPED event can race ahead
        // of that STARTED event; dropping the identity here would make a
        // later backend capture impossible for stop() to reach.
        if (!startingRecorder?.cancelRequested || stoppedActive) startingRecorder = null;
      }
    }
    const startedMode = recorderForEvent?.mode ?? (event === ASCENT_EVENTS.REPLAY_STARTED ? 'replay' : 'video');
    publish({
      lastEvent: { ...message, at: clock() },
      ...(started && recorderForEvent ? { running: true, mode: startedMode, startedAt: state.startedAt ?? clock(), error: null } : {}),
      ...(stopped ? { running: false, mode: null, startedAt: null } : {}),
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
    const runtime = runtimeResolver();
    if (!runtime) {
      publish({ available: false, error: 'Bundled ascent-obs runtime is unavailable' });
      throw new Error('Bundled ascent-obs runtime is unavailable');
    }
    terminationStarted = false;
    protocolFailure = null;
    child = spawn(runtime.executable, [], { cwd: runtime.root, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    output = '';
    decoder = new StringDecoder('utf8');
    const stderrState = { output: '', decoder: new StringDecoder('utf8'), flushed: false };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', (chunk) => {
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
      if (diagnostic) publish({ error: diagnostic });
    };
    child.stderr?.once('close', flushStderr);
    child.on('error', (error) => {
      publish({ available: false, running: false, mode: null, startedAt: null, error: error.message });
      rejectPending(error);
      rejectQueued(error);
    });
    // ChildProcess 'close' follows 'exit' and all stdio streams closing. The
    // stderr close handler covers implementations that expose that boundary
    // without emitting a child close event; the guard makes either path one-shot.
    child.once('close', flushStderr);
    child.on('exit', (code, signal) => {
      const failure = protocolFailure;
      child = null;
      activeRecorder = null;
      startingRecorder = null;
      replayCapture = null;
      terminationStarted = false;
      publish({ available: false, running: false, mode: null, startedAt: null, error: failure ? `Ascent protocol error: ${failure.message}` : disposed ? null : `Ascent exited (${code ?? signal ?? 'unknown'})` });
      rejectPending(failure ?? new Error('Ascent process exited'));
      rejectQueued(failure ?? new Error('Ascent process exited'));
      protocolFailure = null;
    });
    publish({ available: true, error: null });
    return child;
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
    const response = await request(ASCENT_COMMANDS.QUERY_MACHINE_INFO, ASCENT_RECORDER_TYPES.VIDEO, {}, [ASCENT_EVENTS.QUERY_MACHINE_INFO], 5000, null, { acceptUnidentified: true });
    const encoders = Array.isArray(response.vid_encs) ? response.vid_encs.map((encoder) => {
      const type = String(encoder.type ?? '');
      const demoted = demotedEncoders.has(type);
      const valid = encoder.valid === true;
      return { ...encoder, type, enumerated: true, probeValid: valid && !demoted, startTested: demoted, startSupported: valid && !demoted, code: demoted ? -8 : null, status: demoted ? 'start rejected' : valid ? '' : 'invalid' };
    }) : [];
    publish({ encoders });
    return { ...state, encoders };
  }

  async function startInternal(settings, mode = 'video') {
    if (activeRecorder || startingRecorder || state.running) throw new Error('Ascent recorder is already active or a previous start is still pending');
    await probeInternal();
    const outputPath = settings.outputPath;
    const type = mode === 'replay' ? ASCENT_RECORDER_TYPES.REPLAY : ASCENT_RECORDER_TYPES.VIDEO;
    const selectedEncoder = demotedEncoders.has(settings.encoderId) ? 'automatic' : settings.encoderId;
    const encoderId = resolveRecordingEncoder(selectedEncoder, state.encoders);
    const payload = buildAscentStartPayload({ ...settings, encoderId }, outputPath, type);
    const identifier = nextIdentifier++;
    const fields = Object.fromEntries(Object.entries(payload).filter(([key]) => !['cmd', 'identifier', 'recorder_type'].includes(key)));
    startingRecorder = { identifier, type, mode, ready: false };
    try {
      await request(payload.cmd, type, fields, [mode === 'replay' ? ASCENT_EVENTS.REPLAY_STARTED : ASCENT_EVENTS.RECORDING_STARTED], startTimeoutMs, identifier);
    } catch (error) {
      if (startingRecorder?.identifier === identifier && error?.code === 'ASCENT_TIMEOUT' && startingRecorder.ready) {
        // A READY event means the backend accepted the start, but the actual
        // started event may still arrive after the request window. Keep the
        // recorder identity so a late event becomes an active capture that
        // stop() can control; competing starts remain blocked meanwhile.
        startingRecorder.timedOut = true;
        publish({ error: 'Recording start is still pending; stop to cancel it.' });
      } else if (startingRecorder?.identifier === identifier) {
        startingRecorder = null;
      }
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
    // The started event has already made the recorder active. Keep its
    // authoritative mode/timestamp and only add the successful encoder
    // validation here.
    publish({ error: null, encoders: state.encoders.map((item) => item.type === payload.video_settings.video_encoder.id ? { ...item, startTested: true, startSupported: true, status: 'started' } : item) });
    return state;
  }

  async function stopInternal() {
    if (!child) return state;
    const recorder = activeRecorder ?? startingRecorder;
    if (!recorder) return state;
    if (recorder.stopInFlight) return state;
    if (!activeRecorder && startingRecorder?.identifier === recorder.identifier) recorder.cancelRequested = true;
    recorder.stopInFlight = true;
    const stopEvent = recorder.type === ASCENT_RECORDER_TYPES.REPLAY ? ASCENT_EVENTS.REPLAY_STOPPED : ASCENT_EVENTS.RECORDING_STOPPED;
    try {
      await request(ASCENT_COMMANDS.STOP, recorder.type, {}, [stopEvent], 10000, recorder.identifier);
      const stoppedActive = activeRecorder?.identifier === recorder.identifier;
      if (stoppedActive) activeRecorder = null;
      if (startingRecorder?.identifier === recorder.identifier && (stoppedActive || startingRecorder.startedAfterCancel)) startingRecorder = null;
      publish({ running: false, mode: null, startedAt: null });
      return state;
    } finally {
      recorder.stopInFlight = false;
    }
  }

  async function stopReplayClipInternal(identifier = activeRecorder?.identifier) {
    if (!Number.isSafeInteger(identifier)) throw new Error('Replay buffer is not active');
    return request(ASCENT_COMMANDS.STOP_REPLAY_CAPTURE, ASCENT_RECORDER_TYPES.REPLAY, {}, [ASCENT_EVENTS.REPLAY_CAPTURE_VIDEO_READY], 10000, identifier);
  }

  function replayCaptureAlreadyActive(error) {
    return /already\s+(?:capturing|started|active)|capture(?:d|)\s+is\s+already\s+active/i.test(String(error?.message ?? ''));
  }

  async function recoverReplayCapture() {
    const capture = replayCapture;
    if (!capture) return true;
    try {
      await stopReplayClipInternal(capture.bufferIdentifier);
      replayCapture = null;
      return true;
    } catch (error) {
      capture.phase = 'unknown';
      capture.recoveryError = error;
      publish({ error: `Replay clip recovery failed: ${error.message}` });
      return false;
    }
  }

  async function saveReplayClipInternal({ path: clipPath, headDuration, thumbnailFolder }) {
    if (!activeRecorder || activeRecorder.type !== ASCENT_RECORDER_TYPES.REPLAY) throw new Error('Start the replay buffer before saving a clip');
    if (replayCapture && !(await recoverReplayCapture())) throw new Error('A replay clip is still being finalized; stop and restart the replay buffer before trying again');
    const bufferIdentifier = activeRecorder.identifier;
    const captureIdentifier = nextIdentifier++;
    replayCapture = { bufferIdentifier, captureIdentifier, phase: 'starting' };
    try {
      await request(ASCENT_COMMANDS.START_REPLAY_CAPTURE, ASCENT_RECORDER_TYPES.REPLAY, { path: clipPath, head_duration: Math.max(0, Math.round(headDuration)), thumbnail_folder: thumbnailFolder }, [ASCENT_EVENTS.REPLAY_CAPTURE_VIDEO_STARTED], 10000, captureIdentifier);
      // Ascent acknowledges START_REPLAY_CAPTURE before writing the file. The
      // file is only usable after STOP_REPLAY_CAPTURE causes replay_ready.
      replayCapture.phase = 'capturing';
      const response = await stopReplayClipInternal(bufferIdentifier);
      replayCapture = null;
      return response;
    } catch (error) {
      // Once START_REPLAY_CAPTURE was accepted, always attempt one bounded
      // STOP_REPLAY_CAPTURE recovery. A stale backend capture is otherwise
      // likely to reject the next Save Clip as "already capturing". If the
      // start itself reported that race, the same recovery also clears the
      // stale backend state before the next user attempt.
      if (replayCapture?.bufferIdentifier === bufferIdentifier && (replayCapture.phase !== 'starting' || replayCaptureAlreadyActive(error))) {
        await recoverReplayCapture();
      } else {
        replayCapture = null;
      }
      throw error;
    }
  }

  async function shutdownInternal() {
    disposed = true;
    if (!child) return state;
    if (state.running || startingRecorder) {
      try { await Promise.race([stopInternal(), new Promise((resolve) => setTimeout(resolve, shutdownMs))]); } catch { /* kill fallback below */ }
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
    probe: () => serialize(probeInternal),
    startRecording: (settings) => serialize(() => startInternal(settings, 'video')),
    startReplay: (settings) => serialize(() => startInternal(settings, 'replay')),
    stop: () => serialize(stopInternal),
    saveReplayClip: (settings) => serialize(() => saveReplayClipInternal(settings)),
    stopReplayClip: (identifier) => serialize(() => stopReplayClipInternal(identifier)),
    shutdown: () => serialize(shutdownInternal),
    subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  };
}
