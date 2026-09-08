import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn as spawnProcess } from 'node:child_process';

const TRIM_TIMEOUT_MS = 30000;
const TRIM_LOCK_RETRY_MS = 3000;
const TRIM_LOCK_RETRY_DELAY_MS = 50;
// Stream-copy trimming can land on the preceding keyframe. Allow one GOP of
// bounded lead-in so replay saves stay fast; the native request and the
// destination duration are still limited to the requested tail.
const DURATION_TOLERANCE_MS = 750;

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
    '-preset', 'ultrafast',
    '-crf', '18',
    '-c:a', 'aac',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'mp4',
    '-y', outputPath,
  ];
}

export function recordingClipCopyArguments(inputPath, outputPath, durationMs, sourceDurationMs = null) {
  const seconds = validDurationSeconds(durationMs);
  if (!seconds || typeof inputPath !== 'string' || typeof outputPath !== 'string') return null;
  const duration = seconds.toFixed(3);
  const sourceDuration = Number(sourceDurationMs);
  const tailOffset = Number.isFinite(sourceDuration) && sourceDuration > 0
    ? Math.max(0, sourceDuration - Number(durationMs)) / 1000
    : null;
  const seekInput = tailOffset === null
    ? ['-sseof', `-${duration}`, '-i', inputPath]
    : ['-i', inputPath, '-ss', tailOffset.toFixed(3)];
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    ...seekInput,
    '-map', '0',
    '-t', duration,
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    '-f', 'mp4',
    '-y', outputPath,
  ];
}

function runTrim(spawn, executable, args) {
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

function probeDuration(spawn, executable, filePath) {
  if (typeof executable !== 'string' || !executable || typeof filePath !== 'string' || !filePath) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    let stdout = '';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child?.kill(); } catch { /* best effort */ }
      finish(null);
    }, TRIM_TIMEOUT_MS);
    try {
      child = spawn(executable, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        '--', filePath,
      ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      child.stdout?.on('data', (chunk) => {
        stdout = `${stdout}${String(chunk)}`.slice(0, 128);
      });
      child.once('error', () => finish(null));
      child.once('close', (code) => {
        if (code !== 0) return finish(null);
        const duration = Number.parseFloat(stdout.trim());
        finish(Number.isFinite(duration) && duration > 0 ? duration * 1000 : null);
      });
    } catch {
      finish(null);
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
 * trim cannot be verified, return false so the caller can fail the save rather
 * than publish the rolling source as a successful clip.
 */
export async function trimRecordingClipToDuration(filePath, durationMs, {
  ffmpegPath,
  ffprobePath,
  spawn = spawnProcess,
  fsImpl = fs,
  destinationPath = filePath,
  tempSuffix = `${process.pid}-${randomUUID()}`,
  lockRetryMs = TRIM_LOCK_RETRY_MS,
  lockRetryDelayMs = TRIM_LOCK_RETRY_DELAY_MS,
} = {}) {
  if (typeof filePath !== 'string' || !filePath || typeof destinationPath !== 'string' || !destinationPath
    || typeof ffmpegPath !== 'string' || !ffmpegPath || !validDurationSeconds(durationMs)) return false;
  if (!hasUsableFile(fsImpl, filePath)) return false;
  const replaceInPlace = path.resolve(filePath) === path.resolve(destinationPath);
  // A replay muxer can keep the native source open after STOP_REPLAY_CAPTURE
  // has answered.  When a separate destination is supplied, never rename or
  // unlink that source as part of publishing the verified bounded clip.
  const temporaryPath = `${destinationPath}.arc-trim-${tempSuffix}.tmp`;
  const sourceSnapshotPath = `${filePath}.arc-source-${tempSuffix}.mp4`;
  if (path.resolve(temporaryPath) === path.resolve(filePath)) return false;
  let publishedFallbackPath = null;
  let sourceForTrim = filePath;
  try {
    const outputMatchesDuration = async () => {
      if (!ffprobePath) return true;
      const actualDurationMs = await probeDuration(spawn, ffprobePath, temporaryPath);
      return Number.isFinite(actualDurationMs)
        && actualDurationMs > 0
        // A replay buffer may have been armed for less time than the
        // requested window on the first save. A shorter, verified tail is
        // valid; an output longer than requested is the bug we must reject.
        && actualDurationMs <= Number(durationMs) + DURATION_TOLERANCE_MS;
    };
    const removeTemporary = () => {
      try { fsImpl.unlinkSync(temporaryPath); } catch { /* no output or a transient lock */ }
    };
    const renderBoundedOutput = async (sourcePath) => {
      const sourceDurationMs = ffprobePath ? await probeDuration(spawn, ffprobePath, sourcePath) : null;
      // Stream-copy first. Replay clips are already encoded, so this avoids
      // re-encoding several minutes of video just to keep a ten-second tail.
      // If a keyframe/PTS lead-in makes the copy too long, use the exact
      // re-encode below and verify that result before publishing it.
      if (await runTrim(spawn, ffmpegPath, recordingClipCopyArguments(sourcePath, temporaryPath, durationMs, sourceDurationMs))
        && hasUsableFile(fsImpl, temporaryPath)
        && await outputMatchesDuration()) return true;
      removeTemporary();
      if (await runTrim(spawn, ffmpegPath, recordingClipTrimArguments(sourcePath, temporaryPath, durationMs))
        && hasUsableFile(fsImpl, temporaryPath)
        && await outputMatchesDuration()) return true;
      removeTemporary();
      return false;
    };

    // Detach the replay from the native muxer before invoking FFmpeg. The
    // runtime can keep its output handle open after replay_ready; pointing
    // FFmpeg at that path first can block for its full timeout and then turn
    // a transient lock into the user-facing EBUSY cleanup error. A completed
    // snapshot is independent of that handle and is still much faster than
    // re-encoding the rolling source.
    if (typeof fsImpl.copyFileSync === 'function') {
      try {
        await retryFileOperation(() => fsImpl.copyFileSync(filePath, sourceSnapshotPath), { timeoutMs: lockRetryMs, delayMs: lockRetryDelayMs });
        sourceForTrim = sourceSnapshotPath;
      } catch {
        sourceForTrim = filePath;
      }
    }
    if (!await renderBoundedOutput(sourceForTrim)) {
      // Keep the native direct-read fallback for runtimes/filesystems where a
      // snapshot is denied even though FFmpeg can still read the source.
      if (sourceForTrim !== filePath && await renderBoundedOutput(filePath)) {
        sourceForTrim = filePath;
      } else {
        return false;
      }
    }
    if (!replaceInPlace) {
      try {
        await retryFileOperation(() => fsImpl.renameSync(temporaryPath, destinationPath), { timeoutMs: lockRetryMs, delayMs: lockRetryDelayMs });
        return { ok: true, path: destinationPath, bounded: true };
      } catch (destinationError) {
        const fallbackPath = availableFallbackPath(destinationPath, fsImpl);
        if (!fallbackPath) throw destinationError;
        await retryFileOperation(() => fsImpl.renameSync(temporaryPath, fallbackPath), { timeoutMs: lockRetryMs, delayMs: lockRetryDelayMs });
        publishedFallbackPath = fallbackPath;
        return { ok: true, path: fallbackPath, bounded: true, fallback: true };
      }
    }

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
    try {
      await retryFileOperation(() => fsImpl.unlinkSync(sourceSnapshotPath), { timeoutMs: lockRetryMs, delayMs: lockRetryDelayMs });
    } catch {
      // A source snapshot is only an optimization for a locked native file;
      // leave it recoverable if a third-party handle outlives this operation.
    }
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
