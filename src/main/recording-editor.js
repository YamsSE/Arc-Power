import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn as spawnProcess } from 'node:child_process';
import { isPathWithinRoot, safeVideoExtension } from './recording-pure.js';
import { isOpaqueClipId, resolveSafeRecordingPath } from './recording-media.js';

export const RECORDING_EDITOR_STATES = Object.freeze(['queued', 'running', 'ready', 'cancelled', 'error']);
export const RECORDING_EDITOR_TRIM_MAX_MS = 3_600_000;
export const RECORDING_EDITOR_GIF_MIN_MS = 1_000;
export const RECORDING_EDITOR_GIF_MAX_MS = 15_000;
export const RECORDING_EDITOR_GIF_MIN_FPS = 5;
export const RECORDING_EDITOR_GIF_MAX_FPS = 30;
export const RECORDING_EDITOR_GIF_MAX_WIDTH = 1_920;
export const RECORDING_EDITOR_OUTPUT_NAME_MAX = 96;
export const RECORDING_EDITOR_VERSION = 1;

const EDITOR_ID = /^[A-Za-z0-9_-]{8,128}$/;
const EDITOR_OUTPUT_EXTENSIONS = Object.freeze(['.mp4', '.gif']);
const DEFAULT_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 15_000;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberInRange(value, min, max, integer = false) {
  const numeric = finiteNumber(value);
  if (numeric === null || numeric < min || numeric > max) return null;
  if (integer && !Number.isSafeInteger(numeric)) return null;
  return numeric;
}

export function normalizeRecordingEditorOutputName(value, fallback = 'Arc Edit') {
  const source = value === undefined || value === null || value === '' ? fallback : value;
  if (typeof source !== 'string' || source.length > RECORDING_EDITOR_OUTPUT_NAME_MAX) return null;
  const trimmed = source.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[\\/\0\r\n]/.test(trimmed) || /[<>:"|?*]/.test(trimmed)) return null;
  const basename = path.basename(trimmed);
  if (basename !== trimmed || basename.startsWith('.')) return null;
  const withoutKnownExtension = basename.replace(/\.(?:mp4|gif)$/i, '').trim();
  if (!withoutKnownExtension || withoutKnownExtension === '.' || withoutKnownExtension === '..') return null;
  return withoutKnownExtension.slice(0, RECORDING_EDITOR_OUTPUT_NAME_MAX);
}

export function normalizeRecordingEditorRequest(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('recording-editor-start: payload must be an object');
  if (!isOpaqueClipId(payload.sourceId)) throw new Error('recording-editor-start: invalid source id');
  if (payload.operation !== 'trim' && payload.operation !== 'gif') throw new Error('recording-editor-start: operation must be trim or gif');
  const startMs = numberInRange(payload.startMs, 0, RECORDING_EDITOR_TRIM_MAX_MS, true);
  const endMs = numberInRange(payload.endMs, 0, RECORDING_EDITOR_TRIM_MAX_MS, true);
  if (startMs === null || endMs === null || startMs >= endMs) throw new Error('recording-editor-start: invalid time range');
  const durationMs = endMs - startMs;
  const audio = payload.audio === undefined ? 'original' : payload.audio;
  if (!['original', 'mute', 'system'].includes(audio)) throw new Error('recording-editor-start: audio must be original, mute, or system');
  const maxDurationMs = payload.maxDurationMs === undefined ? null : numberInRange(payload.maxDurationMs, 1, RECORDING_EDITOR_TRIM_MAX_MS, true);
  if (payload.maxDurationMs !== undefined && maxDurationMs === null) throw new Error('recording-editor-start: invalid maximum duration');
  if (maxDurationMs !== null && durationMs > maxDurationMs) throw new Error('recording-editor-start: selected range exceeds maximum duration');
  const fps = payload.fps === undefined ? 15 : numberInRange(payload.fps, RECORDING_EDITOR_GIF_MIN_FPS, RECORDING_EDITOR_GIF_MAX_FPS, true);
  const width = payload.width === undefined ? 640 : numberInRange(payload.width, 2, RECORDING_EDITOR_GIF_MAX_WIDTH, true);
  if (payload.operation === 'gif') {
    if (durationMs < RECORDING_EDITOR_GIF_MIN_MS || durationMs > RECORDING_EDITOR_GIF_MAX_MS) throw new Error('recording-editor-start: GIF duration must be 1 to 15 seconds');
    if (fps === null) throw new Error('recording-editor-start: GIF FPS must be 5 to 30');
    if (width === null) throw new Error('recording-editor-start: GIF width must be 2 to 1920');
  } else if (payload.fps !== undefined && fps === null) {
    throw new Error('recording-editor-start: invalid GIF FPS');
  } else if (payload.width !== undefined && width === null) {
    throw new Error('recording-editor-start: invalid GIF width');
  }
  const outputName = normalizeRecordingEditorOutputName(payload.outputName);
  if (outputName === null) throw new Error('recording-editor-start: invalid output name');
  return {
    sourceId: payload.sourceId,
    operation: payload.operation,
    startMs,
    endMs,
    durationMs,
    audio,
    maxDurationMs,
    fps,
    width,
    outputName,
  };
}

function seconds(ms) {
  return (ms / 1000).toFixed(3);
}

export function recordingEditorTrimArguments(inputPath, outputPath, startMs, endMs, audio = 'original') {
  const start = numberInRange(startMs, 0, RECORDING_EDITOR_TRIM_MAX_MS, true);
  const end = numberInRange(endMs, 1, RECORDING_EDITOR_TRIM_MAX_MS, true);
  if (start === null || end === null || start >= end || typeof inputPath !== 'string' || typeof outputPath !== 'string') return null;
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-ss', seconds(start), '-i', inputPath, '-t', seconds(end - start),
    '-map', '0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    ...(audio === 'mute' ? ['-an'] : ['-c:a', 'aac']), '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart',
    '-f', 'mp4', '-y', outputPath,
  ];
  return args;
}

export function recordingEditorGifArguments(inputPath, outputPath, startMs, endMs, fps = 15, width = 640) {
  const start = numberInRange(startMs, 0, RECORDING_EDITOR_TRIM_MAX_MS, true);
  const end = numberInRange(endMs, 1, RECORDING_EDITOR_TRIM_MAX_MS, true);
  const frameRate = numberInRange(fps, RECORDING_EDITOR_GIF_MIN_FPS, RECORDING_EDITOR_GIF_MAX_FPS, true);
  const maxWidth = numberInRange(width, 2, RECORDING_EDITOR_GIF_MAX_WIDTH, true);
  if (start === null || end === null || start >= end || end - start < RECORDING_EDITOR_GIF_MIN_MS || end - start > RECORDING_EDITOR_GIF_MAX_MS || frameRate === null || maxWidth === null || typeof inputPath !== 'string' || typeof outputPath !== 'string') return null;
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-ss', seconds(start), '-i', inputPath, '-t', seconds(end - start),
    '-vf', `fps=${frameRate},scale=${maxWidth}:-2:flags=lanczos`,
    '-loop', '0', '-f', 'gif', '-y', outputPath,
  ];
}

function artifactExtension(operation) { return operation === 'gif' ? '.gif' : '.mp4'; }

function isRegular(stat) { return Boolean(stat?.isFile?.()) && !stat?.isSymbolicLink?.(); }

function isReparse(stat) {
  return Boolean(stat?.isSymbolicLink?.() || stat?.isJunction?.() || stat?.isReparsePoint?.() || stat?.reparsePoint === true || stat?.attributes?.reparsePoint === true);
}

function realpath(fsImpl, value) {
  try {
    const fn = fsImpl.realpathSync?.native ?? fsImpl.realpathSync;
    return fn.call(fsImpl.realpathSync, value);
  } catch { return null; }
}

function safeArtifactPath(root, relativePath, fsImpl = fs, { allowMissing = false, allowedExtensions = EDITOR_OUTPUT_EXTENSIONS } = {}) {
  if (typeof root !== 'string' || typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) return null;
  const candidate = path.resolve(root, relativePath);
  if (!isPathWithinRoot(root, candidate) || !allowedExtensions.includes(path.extname(candidate).toLowerCase())) return null;
  const rootResolved = path.resolve(root);
  let current = candidate;
  const chain = [];
  while (true) {
    let stat;
    try { stat = fsImpl.lstatSync(current); }
    catch (error) {
      if (allowMissing && current === candidate && error?.code === 'ENOENT') {
        current = path.dirname(current);
        continue;
      }
      return null;
    }
    if (isReparse(stat)) return null;
    const canonical = realpath(fsImpl, current);
    if (!canonical) return null;
    chain.push({ path: current, canonical });
    if (current === rootResolved) break;
    const parent = path.dirname(current);
    if (parent === current || !isPathWithinRoot(rootResolved, parent, { allowRoot: true })) return null;
    current = parent;
  }
  if (chain.length === 0 || path.resolve(chain.at(-1).path) !== rootResolved) return null;
  if (!allowMissing) {
    try { if (!isRegular(fsImpl.statSync(candidate))) return null; } catch { return null; }
  }
  const realRoot = chain.at(-1).canonical;
  const realCandidate = allowMissing && chain.length === 1 ? candidate : (realpath(fsImpl, candidate) ?? candidate);
  if (!isPathWithinRoot(realRoot, realCandidate)) return null;
  return candidate;
}

export function resolveSafeRecordingEditorPath(root, relativePath, fsImpl = fs, options = {}) {
  return safeArtifactPath(root, relativePath, fsImpl, options);
}

function sameIdentity(a, b) {
  if (!a || !b) return false;
  for (const key of ['dev', 'ino', 'size', 'mtimeMs']) {
    if (a[key] !== undefined && b[key] !== undefined && String(a[key]) !== String(b[key])) return false;
  }
  return true;
}

function hasUsableFile(fsImpl, filePath, extension = null) {
  try {
    const stat = fsImpl.statSync(filePath);
    return isRegular(stat) && stat.size > 0 && (!extension || path.extname(filePath).toLowerCase() === extension);
  } catch { return false; }
}

function uniqueName(root, baseName, extension, fsImpl, random = randomUUID) {
  const safeBase = normalizeRecordingEditorOutputName(baseName) ?? 'Arc Edit';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? '' : ` (${attempt + 1})`;
    const candidate = path.join(root, `${safeBase.slice(0, Math.max(1, RECORDING_EDITOR_OUTPUT_NAME_MAX - suffix.length - extension.length))}${suffix}${extension}`);
    if (!isPathWithinRoot(root, candidate)) throw new Error('editor output escaped recording folder');
    try { fsImpl.lstatSync(candidate); } catch (error) {
      if (error?.code === 'ENOENT') return candidate;
    }
  }
  const randomSuffix = String(random()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12) || 'output';
  return path.join(root, `Arc Edit ${randomSuffix}${extension}`);
}

function tempPath(outputPath, id) { return `${outputPath}.arc-editor-${id}.tmp`; }

function publicJob(job) {
  const result = { jobId: job.jobId, state: job.state, progress: job.progress };
  if (job.clip) result.clip = job.clip;
  if (job.artifact) result.artifact = job.artifact;
  if (job.error) result.error = job.error;
  return result;
}

function spawnOnce(spawn, executable, args, timeoutMs, { onProgress, cancelled, onChild } = {}) {
  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    let stderr = '';
    let stdout = '';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...value, stderr, stdout });
    };
    const timer = setTimeout(() => {
      try { child?.kill(); } catch {}
      finish({ ok: false, timedOut: true, stderr });
    }, timeoutMs);
    try {
      child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      onChild?.(child);
      const handleProgress = (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-8192);
        const match = stderr.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)?.at(-1);
        if (match) {
          const value = match.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
          if (value) onProgress?.(Number(value[1]) * 3600 + Number(value[2]) * 60 + Number(value[3]));
        }
      };
      child.stdout?.on?.('data', (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-8192); });
      child.stderr?.on?.('data', handleProgress);
      child.once('error', (error) => finish({ ok: false, error, stderr }));
      child.once('close', (code, signal) => finish({ ok: code === 0 && !cancelled?.(), code, signal, stderr }));
    } catch (error) { finish({ ok: false, error, stderr }); }
    // A mocked child can expose no stderr/event methods. The timer remains the
    // bounded fail-safe for that case.
  });
}

async function probeFile({ fsImpl, spawn, executable, filePath }) {
  if (!hasUsableFile(fsImpl, filePath)) return false;
  if (!executable) return true;
  const result = await spawnOnce(spawn, executable, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', '-i', filePath], PROBE_TIMEOUT_MS);
  if (!result.ok) return false;
  try {
    const parsed = JSON.parse(String(result.stdout ?? ''));
    const duration = Number(parsed?.format?.duration);
    if (Number.isFinite(duration)) return duration > 0;
  } catch { /* equivalent non-empty-file validation below */ }
  return hasUsableFile(fsImpl, filePath);
}

export function createRecordingEditorService({
  recordingStore,
  resolveFfmpegPath = () => null,
  resolveFfprobePath = () => null,
  spawn = spawnProcess,
  fsImpl = fs,
  now = () => new Date().toISOString(),
  randomId = () => randomUUID().replace(/-/g, ''),
  maxConcurrent = 1,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  openFile = async () => false,
  shareFile = async () => false,
} = {}) {
  const jobs = new Map();
  const queue = [];
  let running = 0;

  const update = (job, patch) => Object.assign(job, patch, { progress: Math.min(100, Math.max(0, Number(patch.progress ?? job.progress) || 0)) });
  const fail = (job, message) => update(job, { state: 'error', progress: 0, error: String(message || 'Recording editor failed').slice(0, 256), child: null });
  const processQueue = () => {
    while (running < Math.max(1, maxConcurrent) && queue.length) {
      const job = queue.shift();
      if (!job || job.state !== 'queued') continue;
      running += 1;
      void runJob(job).finally(() => { running -= 1; processQueue(); });
    }
  };

  async function runJob(job) {
    update(job, { state: 'running', progress: 1 });
    let temp = null;
    let outputPath = null;
    let published = false;
    try {
      const settings = await recordingStore?.settings?.();
      const root = typeof settings?.location === 'string' ? path.resolve(settings.location) : null;
      const sourceClip = await recordingStore?.clipById?.(job.request.sourceId);
      if (!root || !sourceClip || !safeVideoExtension(sourceClip.relativePath)) throw new Error('Source clip is unavailable');
      const sourcePath = resolveSafeRecordingPath(root, sourceClip.relativePath, fsImpl);
      if (!sourcePath) throw new Error('Source clip path is unsafe');
      const sourceStat = fsImpl.statSync(sourcePath);
      if (!isRegular(sourceStat)) throw new Error('Source clip is not a regular file');
      const outputExtension = artifactExtension(job.request.operation);
      outputPath = uniqueName(root, job.request.outputName, outputExtension, fsImpl, randomId);
      if (!safeArtifactPath(root, path.relative(root, outputPath), fsImpl, { allowMissing: true })) throw new Error('Output path is unsafe');
      temp = tempPath(outputPath, job.jobId);
      if (!safeArtifactPath(root, path.relative(root, temp), fsImpl, { allowMissing: true, allowedExtensions: ['.tmp'] })) throw new Error('Temporary output path is unsafe');
      const executable = resolveFfmpegPath();
      if (!executable) throw new Error('Bundled FFmpeg is unavailable');
      const args = job.request.operation === 'gif'
        ? recordingEditorGifArguments(sourcePath, temp, job.request.startMs, job.request.endMs, job.request.fps, job.request.width)
        : recordingEditorTrimArguments(sourcePath, temp, job.request.startMs, job.request.endMs, job.request.audio);
      if (!args) throw new Error('Invalid editor bounds');
      const result = await spawnOnce(spawn, executable, args, timeoutMs, {
        cancelled: () => job.cancelRequested,
        onProgress: (elapsedSec) => {
          const selectedSec = Math.max(0.001, job.request.durationMs / 1000);
          update(job, { progress: Math.min(95, Math.max(job.progress, Math.round((elapsedSec / selectedSec) * 95))) });
        },
        onChild: (child) => { job.child = child; },
      });
      if (job.cancelRequested || result.signal === 'SIGTERM' || result.signal === 'SIGKILL') {
        update(job, { state: 'cancelled', progress: 0, child: null });
        return;
      }
      if (!result.ok) throw new Error(result.timedOut ? 'FFmpeg timed out' : (result.error?.message || 'FFmpeg failed'));
      if (!hasUsableFile(fsImpl, temp)) throw new Error('FFmpeg produced an invalid output');
      const currentSource = fsImpl.statSync(sourcePath);
      if (!sameIdentity(sourceStat, currentSource)) throw new Error('Source clip changed during editing');
      if (!await probeFile({ fsImpl, spawn, executable: resolveFfprobePath(), filePath: temp })) throw new Error('Output validation failed');
      if (job.cancelRequested) {
        update(job, { state: 'cancelled', progress: 0, child: null });
        return;
      }
      try { fsImpl.lstatSync(outputPath); throw new Error('Output collision'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      fsImpl.renameSync(temp, outputPath);
      temp = null;
      published = true;
      const outputRelative = path.relative(root, outputPath);
      if (!safeArtifactPath(root, outputRelative, fsImpl) || !hasUsableFile(fsImpl, outputPath, outputExtension)) throw new Error('Published output is unsafe');
      if (job.request.operation === 'trim') {
        const sourceMarkers = Array.isArray(sourceClip.markerSummaries) ? sourceClip.markerSummaries : [];
        const markerSummaries = sourceMarkers
          .filter((marker) => Number.isFinite(marker?.atMs) && marker.atMs >= job.request.startMs && marker.atMs <= job.request.endMs)
          .slice(0, 500)
          .map((marker) => ({ ...marker, atMs: Math.max(0, Math.round(marker.atMs - job.request.startMs)) }));
        const clip = await recordingStore.recordClip({ relativePath: outputRelative, fileName: path.basename(outputPath), editorVersion: RECORDING_EDITOR_VERSION, markerSummaries });
        update(job, { state: 'ready', progress: 100, child: null, clip });
      } else {
        update(job, { state: 'ready', progress: 100, child: null, artifact: { kind: 'gif', fileName: path.basename(outputPath), relativePath: outputRelative, extension: '.gif', durationMs: job.request.durationMs, fps: job.request.fps, width: job.request.width } });
      }
    } catch (error) {
      if (job.cancelRequested) update(job, { state: 'cancelled', progress: 0, child: null });
      else fail(job, error?.message ?? error);
    } finally {
      if (temp) { try { fsImpl.unlinkSync(temp); } catch {} }
      if (published && outputPath && job.state !== 'ready') { try { fsImpl.unlinkSync(outputPath); } catch {} }
      job.child = null;
    }
  }

  return {
    async start(payload) {
      const request = normalizeRecordingEditorRequest(payload);
      const jobId = randomId();
      if (!EDITOR_ID.test(jobId)) throw new Error('Could not allocate editor job id');
      const job = { jobId, request, state: 'queued', progress: 0, error: null, clip: null, artifact: null, child: null, cancelRequested: false, createdAt: now() };
      jobs.set(jobId, job);
      queue.push(job);
      queueMicrotask(processQueue);
      return publicJob(job);
    },
    status(jobId) {
      if (!EDITOR_ID.test(jobId) || !jobs.has(jobId)) throw new Error('recording-editor-status: job not found');
      return publicJob(jobs.get(jobId));
    },
    cancel(jobId) {
      if (!EDITOR_ID.test(jobId) || !jobs.has(jobId)) throw new Error('recording-editor-cancel: job not found');
      const job = jobs.get(jobId);
      if (job.state === 'queued') {
        job.cancelRequested = true;
        update(job, { state: 'cancelled', progress: 0 });
      } else if (job.state === 'running') {
        job.cancelRequested = true;
        try { job.child?.kill?.(); } catch {}
      }
      return publicJob(job);
    },
    async open(jobId) {
      if (!EDITOR_ID.test(jobId) || !jobs.has(jobId)) throw new Error('recording-editor-open: job not found');
      const job = jobs.get(jobId);
      if (job.state !== 'ready') throw new Error('recording-editor-open: job is not ready');
      const artifact = job.artifact ?? (job.clip ? { kind: 'clip', fileName: job.clip.fileName, relativePath: job.clip.relativePath } : null);
      if (!artifact || typeof artifact.relativePath !== 'string') throw new Error('recording-editor-open: artifact is unavailable');
      const settings = await recordingStore?.settings?.();
      const root = path.resolve(settings?.location ?? '');
      const filePath = resolveSafeRecordingEditorPath(root, artifact.relativePath, fsImpl);
      if (!filePath) throw new Error('recording-editor-open: artifact path is unsafe');
      if (!(await openFile(filePath))) throw new Error('recording-editor-open: could not open artifact');
      return { ok: true };
    },
    async share(jobId) {
      if (!EDITOR_ID.test(jobId) || !jobs.has(jobId)) throw new Error('recording-editor-share: job not found');
      const job = jobs.get(jobId);
      if (job.state !== 'ready') throw new Error('recording-editor-share: job is not ready');
      const artifact = job.artifact ?? (job.clip ? { kind: 'clip', fileName: job.clip.fileName, relativePath: job.clip.relativePath } : null);
      if (!artifact || typeof artifact.relativePath !== 'string') throw new Error('recording-editor-share: artifact is unavailable');
      const settings = await recordingStore?.settings?.();
      const root = path.resolve(settings?.location ?? '');
      const filePath = resolveSafeRecordingEditorPath(root, artifact.relativePath, fsImpl);
      if (!filePath) throw new Error('recording-editor-share: artifact path is unsafe');
      if (!(await shareFile(filePath, path.dirname(filePath)))) throw new Error('recording-editor-share: could not share artifact');
      return { ok: true };
    },
    shutdown() {
      for (const job of jobs.values()) if (job.state === 'queued' || job.state === 'running') {
        job.cancelRequested = true;
        try { job.child?.kill?.(); } catch {}
        if (job.state === 'queued') update(job, { state: 'cancelled', progress: 0 });
      }
    },
    _jobs: jobs,
  };
}

export const editorTrimArguments = recordingEditorTrimArguments;
export const editorGifArguments = recordingEditorGifArguments;
