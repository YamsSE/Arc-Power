// Arc Power - disposable Electron user-data cache lifecycle.
// Electron-free by design: the filesystem and process seams are injectable so
// startup/reset behavior stays deterministic in focused node tests.

import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export const ARC_POWER_CACHE_DIR_NAME = 'ArcPowerCache';
// These are the user-data identities used by Arc Power over its lifetime.
// They are disposable Electron/browser caches; the similarly named
// `ArcPower` directory is deliberately excluded because it stores profiles
// and other durable user data.
export const ARC_POWER_CACHE_DIR_NAMES = Object.freeze([
  ARC_POWER_CACHE_DIR_NAME,
  'arc-power',
  'rid-arc-power',
]);
export const ARC_POWER_PROFILE_CACHE_FILE_NAMES = Object.freeze([
  'fan-probe-cache.json',
  'igcl-dll-cache.json',
]);
export const ARC_POWER_VERSION_STATE_FILE_NAME = 'runtime-version.json';
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

/** Resolve every disposable user-data root, including legacy Arc Power IDs. */
export function resolveArcPowerCachePaths(appDataPath) {
  assertAbsolutePath(appDataPath, 'appDataPath');
  return ARC_POWER_CACHE_DIR_NAMES.map((name) => path.join(appDataPath, name));
}

/** Resolve the durable marker used to compare the last opened app version. */
export function resolveArcPowerVersionStatePath(appDataPath) {
  assertAbsolutePath(appDataPath, 'appDataPath');
  return path.join(appDataPath, 'ArcPower', ARC_POWER_VERSION_STATE_FILE_NAME);
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value ?? '').trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

/** Compare release versions; returns null when either value is not a release version. */
export function compareArcPowerVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function readLastOpenedVersion(versionStatePath, fsApi) {
  if (!fsApi.existsSync(versionStatePath)) return null;
  try {
    const raw = fsApi.readFileSync(versionStatePath, 'utf8');
    const parsed = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
    return parseVersion(parsed?.lastOpenedVersion) ? String(parsed.lastOpenedVersion).trim() : null;
  } catch {
    return null;
  }
}

function writeLastOpenedVersion(versionStatePath, version, fsApi) {
  const parent = path.dirname(versionStatePath);
  fsApi.mkdirSync(parent, { recursive: true });
  const temporary = `${versionStatePath}.tmp`;
  fsApi.writeFileSync(temporary, JSON.stringify({
    lastOpenedVersion: version,
    updatedAt: new Date().toISOString(),
  }), { encoding: 'utf8', mode: 0o600 });
  fsApi.renameSync(temporary, versionStatePath);
}

function resetCachePathSync(cachePath, fsApi) {
  if (fsApi.existsSync(cachePath)) removeUserDataTreeSync(cachePath, { fs: fsApi });
}

/**
 * Reset all known Arc Power cache roots and cache files, recreating only the
 * current root. The profile directory itself is never a cleanup target.
 */
export function resetArcPowerCachesSync(appDataPath, { fs: fsApi = { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } } = {}) {
  const cachePaths = resolveArcPowerCachePaths(appDataPath);
  const profilePath = path.join(appDataPath, 'ArcPower');
  for (const cachePath of cachePaths) resetCachePathSync(cachePath, fsApi);
  for (const fileName of ARC_POWER_PROFILE_CACHE_FILE_NAMES) {
    const filePath = path.join(profilePath, fileName);
    if (fsApi.existsSync(filePath)) fsApi.rmSync(filePath, { force: true, maxRetries: 3, retryDelay: 100 });
  }
  ensureCacheDirectorySync(cachePaths[0], { fs: fsApi });
  return cachePaths[0];
}

/**
 * Prepare the cache before Electron selects userData. A reset happens only
 * for an actually newer opened version, a first-run migration with existing
 * legacy cache data, or the explicit maintenance flag. Same-version launches
 * are intentionally a no-op for cache contents.
 */
export function prepareArcPowerCacheSync(appDataPath, version, {
  forceReset = false,
  beforeReset = null,
  fs: fsApi = { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync },
} = {}) {
  if (typeof version !== 'string' || !parseVersion(version)) {
    throw new TypeError('version must be a valid dotted release version');
  }
  if (beforeReset !== null && typeof beforeReset !== 'function') {
    throw new TypeError('beforeReset must be a function');
  }
  const cachePaths = resolveArcPowerCachePaths(appDataPath);
  const profilePath = path.join(appDataPath, 'ArcPower');
  const versionStatePath = resolveArcPowerVersionStatePath(appDataPath);
  const previousVersion = readLastOpenedVersion(versionStatePath, fsApi);
  const hasExistingCache = cachePaths.some((cachePath) => fsApi.existsSync(cachePath))
    || ARC_POWER_PROFILE_CACHE_FILE_NAMES.some((fileName) => fsApi.existsSync(path.join(profilePath, fileName)));
  const versionChanged = previousVersion === null
    ? hasExistingCache
    : compareArcPowerVersions(version, previousVersion) > 0;
  const reset = forceReset || versionChanged;
  if (reset) {
    beforeReset?.();
    resetArcPowerCachesSync(appDataPath, { fs: fsApi });
  }
  else ensureCacheDirectorySync(cachePaths[0], { fs: fsApi });

  // Only rewrite the marker when it changed. This keeps a same-version boot
  // free of both cache deletion and unnecessary state churn.
  if (previousVersion !== version) writeLastOpenedVersion(versionStatePath, version, fsApi);
  return Object.freeze({
    cachePath: cachePaths[0],
    cachePaths: Object.freeze(cachePaths),
    previousVersion,
    reset,
    versionStatePath,
  });
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
