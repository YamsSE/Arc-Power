import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn as spawnProcess } from 'node:child_process';

const TRIM_TIMEOUT_MS = 30000;
const TRIM_LOCK_RETRY_MS = 3000;
const TRIM_LOCK_RETRY_DELAY_MS = 50;

function retryableFileError(error) {
  return ['EBUSY', 'EPERM', 'EACCES'].includes(error?.code);
}

async function retryFileOperation(operation, {
  timeoutMs = TRIM_LOCK_RETRY_MS,
  delayMs = TRIM_LOCK_RETRY_DELAY_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (!retryableFileError(error) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function validDurationSeconds(durationMs) {
  const value = Number(durationMs);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.max(0.001, value / 1000);
}

export function recordingClipTrimArguments(inputPath, outputPath, durationMs) {
  const seconds = validDurationSeconds(durationMs);
  if (!seconds) return null;
  // Replay capture can have no keyframe near the requested start (especially
  // when the native output is a long-lived session). Stream-copy trimming can
  // then fall back to the first keyframe and preserve the whole recording.
  // Re-encode the video/audio tail so the duration bound is real, not merely a
  // best-effort timestamp hint.
  const duration = seconds.toFixed(3);
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-sseof', `-${duration}`,
    '-i', inputPath,
    '-map', '0',
    '-t', duration,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-c:a', 'aac',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'mp4',
    '-y', outputPath,
  ];
}

function runTrim(spawn, executable, inputPath, outputPath, durationMs) {
  const args = recordingClipTrimArguments(inputPath, outputPath, durationMs);
  if (!args) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try { child?.kill(); } catch { /* best effort */ }
      finish(false);
    }, TRIM_TIMEOUT_MS);
    try {
      child = spawn(executable, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.once('error', () => finish(false));
      child.once('close', (code) => finish(code === 0));
    } catch {
      finish(false);
    }
  });
}

function hasUsableFile(fsImpl, filePath) {
  try {
    const stat = fsImpl.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch { return false; }
}

function availableFallbackPath(filePath, fsImpl) {
  const parsed = path.parse(filePath);
  for (let index = 1; index <= 100; index += 1) {
    const suffix = index === 1 ? ' (trimmed)' : ` (trimmed ${index})`;
    const candidate = path.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext || '.mp4'}`);
    try { fsImpl.lstatSync(candidate); } catch (error) {
      if (error?.code === 'ENOENT') return candidate;
    }
  }
  return null;
}

/**
 * Bound a replay clip to the requested tail duration without touching the
 * original until the replacement file has completed successfully. If the
 * optional ffmpeg step is unavailable or fails, the runtime's original clip
 * remains intact and the caller can still report a successful capture.
 */
export async function trimRecordingClipToDuration(filePath, durationMs, {
  ffmpegPath,
  spawn = spawnProcess,
  fsImpl = fs,
  tempSuffix = `${process.pid}-${randomUUID()}`,
  lockRetryMs = TRIM_LOCK_RETRY_MS,
  lockRetryDelayMs = TRIM_LOCK_RETRY_DELAY_MS,
} = {}) {
  if (typeof filePath !== 'string' || !filePath || typeof ffmpegPath !== 'string' || !ffmpegPath || !validDurationSeconds(durationMs)) return false;
  if (!hasUsableFile(fsImpl, filePath)) return false;
  const temporaryPath = `${filePath}.arc-trim-${tempSuffix}.tmp`;
  if (path.resolve(temporaryPath) === path.resolve(filePath)) return false;
  let publishedFallbackPath = null;
  try {
    if (!await runTrim(spawn, ffmpegPath, filePath, temporaryPath, durationMs) || !hasUsableFile(fsImpl, temporaryPath)) return false;
    const backupPath = `${filePath}.arc-original-${tempSuffix}.tmp`;
    try {
      await retryFileOperation(() => fsImpl.renameSync(filePath, backupPath), { timeoutMs: lockRetryMs, delayMs: lockRetryDelayMs });
    } catch (originalError) {
      // Ascent can keep the native output handle open after it has emitted
      // replay-ready. Do not delete the valid native clip just because its
      // requested filename cannot be replaced yet. Publish the bounded copy
      // beside it and let the caller persist that actual path.
      const fallbackPath = availableFallbackPath(filePath, fsImpl);
      if (!fallbackPath) throw originalError;
      await retryFileOperation(() => fsImpl.renameSync(temporaryPath, fallbackPath), { timeoutMs: lockRetryMs, delayMs: lockRetryDelayMs });
      publishedFallbackPath = fallbackPath;
      return { ok: true, path: fallbackPath, bounded: true, fallback: true };
    }
    try {
      await retryFileOperation(() => fsImpl.renameSync(temporaryPath, filePath), { timeoutMs: lockRetryMs, delayMs: lockRetryDelayMs });
    } catch (error) {
      try {
        await retryFileOperation(() => fsImpl.renameSync(backupPath, filePath), { timeoutMs: lockRetryMs, delayMs: lockRetryDelayMs });
      } catch {
        // If the original handle is still held, preserve both recoverable
        // files by publishing the completed bounded output under a sibling
        // path instead of turning a valid capture into a failed save.
        const fallbackPath = availableFallbackPath(filePath, fsImpl);
        if (fallbackPath) {
          await retryFileOperation(() => fsImpl.renameSync(temporaryPath, fallbackPath), { timeoutMs: lockRetryMs, delayMs: lockRetryDelayMs });
          publishedFallbackPath = fallbackPath;
          return { ok: true, path: fallbackPath, bounded: true, fallback: true };
        }
      }
      throw error;
    }
    try {
      await retryFileOperation(() => fsImpl.unlinkSync(backupPath), { timeoutMs: lockRetryMs, delayMs: lockRetryDelayMs });
    } catch {
      // The replacement is already authoritative. Keep the backup as a
      // recoverable copy when Windows still has a transient handle open.
    }
    return true;
  } catch {
    return false;
  } finally {
    if (!publishedFallbackPath) {
      try {
        await retryFileOperation(() => fsImpl.unlinkSync(temporaryPath), { timeoutMs: lockRetryMs, delayMs: lockRetryDelayMs });
      } catch {
        // A failed replacement never removes the original. The temp remains
        // recoverable if a third-party handle outlives this bounded cleanup.
      }
    }
  }
}
