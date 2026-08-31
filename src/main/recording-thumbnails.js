import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import { isOpaqueClipId } from './recording-media.js';

const DEFAULT_MAX_CONCURRENT = 2;
const THUMBNAIL_TIMEOUT_MS = 15000;
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;

function cacheKeyFor(id, stat) {
  return crypto.createHash('sha256')
    .update(`${id}\0${stat.size}\0${stat.mtimeMs}`)
    .digest('hex');
}

function thumbnailPath(cacheDir, id, stat) {
  return path.join(cacheDir, `${cacheKeyFor(id, stat)}.jpg`);
}

function thumbnailArguments(filePath, outputPath, seekSeconds) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-ss', String(seekSeconds),
    '-i', filePath,
    '-map', '0:v:0',
    '-frames:v', '1',
    '-vf', 'scale=640:-2:force_original_aspect_ratio=decrease',
    '-q:v', '3',
    '-f', 'mjpeg',
    '-y', outputPath,
  ];
}

function runFfmpeg(spawn, executable, filePath, outputPath, seekSeconds) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    let child;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => {
      try { child?.kill(); } catch { /* best effort */ }
      finish(new Error('Thumbnail generation timed out'));
    }, THUMBNAIL_TIMEOUT_MS);
    try {
      child = spawn(executable, thumbnailArguments(filePath, outputPath, seekSeconds), {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 4096) stderr = stderr.slice(-4096);
      });
      child.once('error', (error) => finish(error));
      child.once('close', (code) => {
        if (code === 0) finish();
        else finish(new Error(stderr.trim() || `Thumbnail generator exited with code ${code}`));
      });
    } catch (error) {
      finish(error);
    }
  });
}

function enqueue(task, queue, active, maxConcurrent, pump) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

/**
 * Generate small, cached JPEG frames for the clip library. The renderer gets
 * an image immediately, while the full media URL remains lazy and is only
 * requested after the card has been hovered for 500 ms.
 */
export function createRecordingThumbnailService({
  cacheDir,
  resolveFfmpegPath,
  spawn = spawnProcess,
  fsImpl = fs,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
} = {}) {
  const inFlight = new Map();
  const queue = [];
  let active = 0;
  const limit = Number.isSafeInteger(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : DEFAULT_MAX_CONCURRENT;

  const pump = () => {
    while (active < limit && queue.length > 0) {
      const item = queue.shift();
      active += 1;
      Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => {
        active -= 1;
        pump();
      });
    }
  };

  async function readCached(outputPath) {
    try {
      const stat = await fsImpl.promises.stat(outputPath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_THUMBNAIL_BYTES) return null;
      return await fsImpl.promises.readFile(outputPath);
    } catch {
      return null;
    }
  }

  async function generate(id, filePath, outputPath, executable) {
    await fsImpl.promises.mkdir(cacheDir, { recursive: true });
    const cached = await readCached(outputPath);
    if (cached) return cached;

    const temporaryPath = `${outputPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      let generated = false;
      for (const seekSeconds of [0.5, 0]) {
        try {
          await runFfmpeg(spawn, executable, filePath, temporaryPath, seekSeconds);
          const stat = await fsImpl.promises.stat(temporaryPath);
          if (stat.isFile() && stat.size > 0 && stat.size <= MAX_THUMBNAIL_BYTES) {
            generated = true;
            break;
          }
        } catch {
          // A very short or not-yet-indexed file can reject the first seek.
        }
        try { await fsImpl.promises.unlink(temporaryPath); } catch { /* absent */ }
      }
      if (!generated) return null;
      try {
        await fsImpl.promises.rename(temporaryPath, outputPath);
      } catch (error) {
        // Another request cannot normally win because of inFlight, but a
        // previously completed process may have populated this cache entry.
        const existing = await readCached(outputPath);
        if (existing) return existing;
        throw error;
      }
      return await readCached(outputPath);
    } finally {
      try { await fsImpl.promises.unlink(temporaryPath); } catch { /* absent */ }
    }
  }

  async function getThumbnail({ id, filePath } = {}) {
    if (!isOpaqueClipId(id) || typeof filePath !== 'string' || !filePath || typeof resolveFfmpegPath !== 'function') return null;
    let stat;
    try {
      stat = await fsImpl.promises.stat(filePath);
      if (!stat.isFile() || stat.size <= 0) return null;
    } catch {
      return null;
    }
    const executable = resolveFfmpegPath();
    if (typeof executable !== 'string' || !executable) return null;
    const outputPath = thumbnailPath(cacheDir, id, stat);
    const key = outputPath;
    if (!inFlight.has(key)) {
      inFlight.set(key, enqueue(() => generate(id, filePath, outputPath, executable), queue, active, limit, pump)
        .finally(() => inFlight.delete(key)));
    }
    return inFlight.get(key);
  }

  return { getThumbnail };
}

export { cacheKeyFor, thumbnailArguments };
