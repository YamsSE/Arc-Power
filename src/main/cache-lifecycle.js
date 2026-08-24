// Arc Power - disposable Electron user-data cache lifecycle.
// Electron-free by design: the filesystem and process seams are injectable so
// startup/reset behavior stays deterministic in focused node tests.

import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { mkdirSync, rmSync } from 'node:fs';

export const ARC_POWER_CACHE_DIR_NAME = 'ArcPowerCache';
export const CLEAR_CACHE_ARG = '--clear-cache';

function assertAbsolutePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw new TypeError(`${label} must be a non-empty absolute path`);
  }
  return value;
}

function assertSafeDirectoryPath(value, label) {
  assertAbsolutePath(value, label);
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new TypeError(`${label} must not be a filesystem root`);
  }
  return value;
}

/** Resolve the cache directory beside (not case-only beside) ArcPower. */
export function resolveArcPowerCachePath(appDataPath) {
  assertAbsolutePath(appDataPath, 'appDataPath');
  return path.join(appDataPath, ARC_POWER_CACHE_DIR_NAME);
}

/** True when argv requests the one-shot pre-boot cache reset. */
export function shouldClearCache(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  return argv.includes(CLEAR_CACHE_ARG);
}

/** Remove reset-only flags before passing arguments to Electron relaunch. */
export function filterRelaunchArgs(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  return argv.filter((arg) => arg !== CLEAR_CACHE_ARG);
}

/**
 * Recursively remove a dedicated user-data tree. The target must be absolute
 * and non-root; rm's force option makes an already-clean reset idempotent.
 */
export async function removeUserDataTree(userDataPath, { fs = { rm } } = {}) {
  assertSafeDirectoryPath(userDataPath, 'userDataPath');
  if (!fs || typeof fs.rm !== 'function') throw new TypeError('fs.rm must be a function');
  await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/** Ensure the dedicated cache root exists, including missing parents. */
export async function ensureCacheDirectory(cachePath, { fs = { mkdir } } = {}) {
  assertSafeDirectoryPath(cachePath, 'cachePath');
  if (!fs || typeof fs.mkdir !== 'function') throw new TypeError('fs.mkdir must be a function');
  await fs.mkdir(cachePath, { recursive: true });
  return cachePath;
}

/** Synchronously remove a dedicated user-data tree before Electron can boot. */
export function removeUserDataTreeSync(userDataPath, { fs = { rmSync } } = {}) {
  assertSafeDirectoryPath(userDataPath, 'userDataPath');
  if (!fs || typeof fs.rmSync !== 'function') throw new TypeError('fs.rmSync must be a function');
  fs.rmSync(userDataPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/** Synchronously ensure the dedicated cache root exists, including parents. */
export function ensureCacheDirectorySync(cachePath, { fs = { mkdirSync } } = {}) {
  assertSafeDirectoryPath(cachePath, 'cachePath');
  if (!fs || typeof fs.mkdirSync !== 'function') throw new TypeError('fs.mkdirSync must be a function');
  fs.mkdirSync(cachePath, { recursive: true });
  return cachePath;
}

/** Synchronously reset a cache root to an empty recreated directory. */
export function resetCacheDirectorySync(cachePath, { fs = { rmSync, mkdirSync } } = {}) {
  removeUserDataTreeSync(cachePath, { fs });
  ensureCacheDirectorySync(cachePath, { fs });
  return cachePath;
}

/** Reset a cache root and leave an empty recreated root behind. */
export async function resetCacheDirectory(cachePath, { fs = { rm, mkdir } } = {}) {
  await removeUserDataTree(cachePath, { fs });
  await ensureCacheDirectory(cachePath, { fs });
  return cachePath;
}
