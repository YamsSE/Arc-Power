import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn as spawnProcess } from 'node:child_process';

const TRIM_TIMEOUT_MS = 30000;

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
} = {}) {
  if (typeof filePath !== 'string' || !filePath || typeof ffmpegPath !== 'string' || !ffmpegPath || !validDurationSeconds(durationMs)) return false;
  if (!hasUsableFile(fsImpl, filePath)) return false;
  const temporaryPath = `${filePath}.arc-trim-${tempSuffix}.tmp`;
  if (path.resolve(temporaryPath) === path.resolve(filePath)) return false;
  try {
    if (!await runTrim(spawn, ffmpegPath, filePath, temporaryPath, durationMs) || !hasUsableFile(fsImpl, temporaryPath)) return false;
    const backupPath = `${filePath}.arc-original-${tempSuffix}.tmp`;
    fsImpl.renameSync(filePath, backupPath);
    try {
      fsImpl.renameSync(temporaryPath, filePath);
    } catch (error) {
      try { fsImpl.renameSync(backupPath, filePath); } catch { /* preserve the recoverable backup */ }
      throw error;
    }
    try { fsImpl.unlinkSync(backupPath); } catch { /* the replacement is already authoritative */ }
    return true;
  } catch {
    return false;
  } finally {
    try { fsImpl.unlinkSync(temporaryPath); } catch { /* absent or already renamed */ }
  }
}
