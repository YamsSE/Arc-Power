// Arc Power - disposable Electron user-data cache lifecycle.
// Electron-free by design: the filesystem and process seams are injectable so
// startup/reset behavior stays deterministic in focused node tests.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';

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
export const ARC_POWER_MAINTENANCE_RECEIPT_FILE_NAME = 'maintenance-request.json';
export const CLEAR_CACHE_ARG = '--clear-cache';
export const MAINTENANCE_ARG_PREFIX = '--arc-power-maintenance=';
export const MAINTENANCE_ACTIONS = Object.freeze(['clear-cache', 'reset', 'reset-with-drivers']);

const DEFAULT_FS = { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync };

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

/** Return only the fixed Arc Power cache paths in the supplied OS data roots. */
export function resolveArcPowerCacheTargets(appDataPath, { localAppDataPath = null } = {}) {
  assertAbsolutePath(appDataPath, 'appDataPath');
  if (localAppDataPath !== null) assertAbsolutePath(localAppDataPath, 'localAppDataPath');
  const roots = [appDataPath, ...(localAppDataPath ? [localAppDataPath] : [])];
  const targets = [];
  for (const root of roots) {
    for (const name of ARC_POWER_CACHE_DIR_NAMES) targets.push(path.join(root, name));
  }
  if (localAppDataPath) {
    // Electron's default Windows cache location predates ArcPowerCache. Keep
    // this to the exact product-name Cache directory; Local diagnostics and
    // updater/download folders are not disposable cache roots.
    targets.push(path.join(localAppDataPath, 'Arc Power', 'Cache'));
  }
  return Object.freeze([...new Set(targets.map((target) => path.resolve(target)))]);
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

/** Read the last successful product version without touching any app data. */
export function readArcPowerLastOpenedVersionSync(appDataPath, { fs: fsApi = DEFAULT_FS } = {}) {
  return readLastOpenedVersion(resolveArcPowerVersionStatePath(appDataPath), fsApi);
}

function maintenanceReceiptPath(appDataPath) {
  assertAbsolutePath(appDataPath, 'appDataPath');
  return path.join(appDataPath, 'ArcPower', ARC_POWER_MAINTENANCE_RECEIPT_FILE_NAME);
}

export function writeMaintenanceReceiptSync(appDataPath, receipt, { fs: fsApi = DEFAULT_FS } = {}) {
  const receiptPath = maintenanceReceiptPath(appDataPath);
  assertNoReparseComponentsSync(receiptPath, fsApi);
  fsApi.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  fsApi.writeFileSync(temporary, JSON.stringify(receipt), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fsApi.renameSync(temporary, receiptPath);
  return receiptPath;
}

/** Validate and consume a confirmed reset receipt before any reset deletion. */
export function consumeMaintenanceReceiptSync(appDataPath, { action, token, version, launchPath, now = Date.now(), maxAgeMs = 5 * 60_000, platform = process.platform, fs: fsApi = DEFAULT_FS } = {}) {
  const receiptPath = maintenanceReceiptPath(appDataPath);
  assertNoReparseComponentsSync(receiptPath, fsApi);
  if (!fsApi.existsSync(receiptPath)) throw new Error('Arc Power reset request has no valid maintenance confirmation');
  let receipt;
  try { receipt = JSON.parse(fsApi.readFileSync(receiptPath, 'utf8')); }
  catch { throw new Error('Arc Power reset request confirmation is invalid'); }
  const samePath = typeof receipt?.launchPath === 'string' && typeof launchPath === 'string'
    && (platform === 'win32' ? path.resolve(receipt.launchPath).toLowerCase() === path.resolve(launchPath).toLowerCase() : path.resolve(receipt.launchPath) === path.resolve(launchPath));
  if (receipt?.action !== action || receipt?.token !== token || !token
    || receipt?.version !== version || !samePath
    || !Number.isFinite(receipt?.createdAt) || now < receipt.createdAt || now - receipt.createdAt > maxAgeMs) {
    throw new Error('Arc Power reset request confirmation is stale or does not match this launch');
  }
  fsApi.unlinkSync(receiptPath);
  return receipt;
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

function assertNoReparseComponentsSync(targetPath, fsApi) {
  assertAbsolutePath(targetPath, 'targetPath');
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = fsApi.lstatSync(current); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink?.() || stat.isReparsePoint?.()) {
      throw new Error(`Refusing to clean a cache path containing a symbolic link or reparse point: ${current}`);
    }
  }
  return resolved;
}

function resetCachePathSync(cachePath, fsApi) {
  assertNoReparseComponentsSync(cachePath, fsApi);
  if (fsApi.existsSync(cachePath)) removeUserDataTreeSync(cachePath, { fs: fsApi });
}

function resolveActiveLockPath(activeLockPath) {
  if (activeLockPath === null) return null;
  assertAbsolutePath(activeLockPath, 'activeLockPath');
  if (path.basename(activeLockPath) !== 'lockfile') {
    throw new TypeError('activeLockPath must name the lockfile file');
  }
  return path.resolve(activeLockPath);
}

function sameCachePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pathContains(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = process.platform === 'win32'
    ? path.relative(parent.toLowerCase(), child.toLowerCase())
    : path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readRecordingMetadataSync(dataPath, fsApi) {
  const recordingPath = path.join(dataPath, 'recording.json');
  assertNoReparseComponentsSync(recordingPath, fsApi);
  if (!fsApi.existsSync(recordingPath)) return undefined;
  try { return JSON.parse(String(fsApi.readFileSync(recordingPath, 'utf8')).replace(/^\uFEFF/, '')); }
  catch { throw new Error('Refusing to clean Arc Power data because recording.json is malformed; repair recording.json before trying again'); }
}

function recordingRootFromMetadata(raw, fsApi) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || !raw.settings || typeof raw.settings !== 'object' || Array.isArray(raw.settings)
    || typeof raw.settings.location !== 'string' || !path.isAbsolute(raw.settings.location)) {
    throw new Error('Refusing to clean Arc Power data because recording.json has no safe absolute recording location; choose a valid Recording output folder before trying again');
  }
  return assertNoReparseComponentsSync(raw.settings.location, fsApi);
}

// Expand only ancestors of preserved paths. Reparse checks precede every
// directory enumeration, and the complete plan is built before any removal.
function planCacheRemovalsSync(targetPath, preservedPaths, removals, fsApi) {
  assertNoReparseComponentsSync(targetPath, fsApi);
  if (preservedPaths.some((preservedPath) => pathContains(preservedPath, targetPath))) return;
  if (!preservedPaths.some((preservedPath) => pathContains(targetPath, preservedPath))) {
    removals.push(targetPath);
    return;
  }
  if (!fsApi.existsSync(targetPath)) return;
  for (const entry of fsApi.readdirSync(targetPath, { withFileTypes: true })) {
    planCacheRemovalsSync(path.join(targetPath, entry.name), preservedPaths, removals, fsApi);
  }
}

/**
 * Reset all known Arc Power cache roots and cache files, recreating only the
 * current root. An active singleton lock inside a known cache root keeps its
 * root and lockfile in place while all other children are removed. The profile
 * directory itself is never a cleanup target.
 */
export function resetArcPowerCachesSync(appDataPath, { localAppDataPath = null, activeLockPath = null, fs: fsApi = DEFAULT_FS } = {}) {
  const resolvedLockPath = resolveActiveLockPath(activeLockPath);
  const cachePaths = resolveArcPowerCachePaths(appDataPath);
  const allCacheTargets = resolveArcPowerCacheTargets(appDataPath, { localAppDataPath });
  const profilePath = path.join(appDataPath, 'ArcPower');
  const profileCacheFiles = ARC_POWER_PROFILE_CACHE_FILE_NAMES.map((fileName) => path.join(profilePath, fileName));
  const recordingMetadata = readRecordingMetadataSync(profilePath, fsApi);
  const preservedPaths = recordingMetadata === undefined ? [] : [recordingRootFromMetadata(recordingMetadata, fsApi)];
  if (resolvedLockPath && allCacheTargets.some((cachePath) => sameCachePath(path.dirname(resolvedLockPath), cachePath))) {
    preservedPaths.push(resolvedLockPath);
  }
  // Complete the path safety plan before the first removal so an unsafe later
  // root cannot leave the earlier cache roots partially cleared.
  for (const target of [...allCacheTargets, ...profileCacheFiles]) assertNoReparseComponentsSync(target, fsApi);
  const cacheRemovals = [];
  for (const cachePath of allCacheTargets) {
    planCacheRemovalsSync(cachePath, preservedPaths, cacheRemovals, fsApi);
  }
  const profileCacheRemovals = profileCacheFiles.filter((filePath) => !preservedPaths.some((preservedPath) => pathContains(preservedPath, filePath)
    || pathContains(filePath, preservedPath)));
  for (const target of cacheRemovals) assertNoReparseComponentsSync(target, fsApi);
  for (const cachePath of cacheRemovals) resetCachePathSync(cachePath, fsApi);
  for (const filePath of profileCacheRemovals) {
    if (fsApi.existsSync(filePath)) fsApi.rmSync(filePath, { force: true, maxRetries: 3, retryDelay: 100 });
  }
  // The active Electron userData root must exist after every reset.
  ensureCacheDirectorySync(cachePaths[0], { fs: fsApi });
  return cachePaths[0];
}

/**
 * Remove only Arc Power's fixed roaming data directory. Reset preserves the
 * exact DriverDownloads child; the stronger reset removes it too. Caller
 * must have quiesced the running app before invoking this pre-boot helper.
 */
export function resetArcPowerDataSync(appDataPath, { includeDriverDownloads = false, fs: fsApi = { ...DEFAULT_FS, readdirSync } } = {}) {
  assertAbsolutePath(appDataPath, 'appDataPath');
  if (typeof includeDriverDownloads !== 'boolean') throw new TypeError('includeDriverDownloads must be boolean');
  const dataPath = path.join(appDataPath, 'ArcPower');
  assertNoReparseComponentsSync(dataPath, fsApi);
  if (!fsApi.existsSync(dataPath)) return { removed: [] };
  const recordingPath = path.join(dataPath, 'recording.json');
  const raw = readRecordingMetadataSync(dataPath, fsApi);
  let retainedRecordingData = null;
  let recordingRoot = null;
  if (raw !== undefined) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || !Number.isSafeInteger(raw.schemaVersion) || raw.schemaVersion < 1 || raw.schemaVersion > 2
      || !Array.isArray(raw.clips) || !Array.isArray(raw.markers)
      || !raw.settings || typeof raw.settings !== 'object' || Array.isArray(raw.settings)
      || typeof raw.settings.location !== 'string') {
      throw new Error('Refusing to reset Arc Power data because recording.json uses an unsupported shape');
    }
    recordingRoot = recordingRootFromMetadata(raw, fsApi);
    if (pathContains(recordingRoot, dataPath)) {
      throw new Error('Refusing to reset Arc Power data because the Recording output folder contains ArcPower preferences; choose a Recording output folder outside ArcPower or inside a dedicated child folder before resetting');
    }
    retainedRecordingData = {
      schemaVersion: raw.schemaVersion,
      clips: raw.clips,
      markers: raw.markers,
      settings: { location: raw.settings.location },
    };
  }
  const entries = fsApi.readdirSync(dataPath, { withFileTypes: true });
  const children = entries.filter((entry) => entry.name.toLowerCase() !== 'tuningquarantine'
    && entry.name.toLowerCase() !== ARC_POWER_VERSION_STATE_FILE_NAME.toLowerCase()
    && (includeDriverDownloads || entry.name.toLowerCase() !== 'driverdownloads'))
    .map((entry) => path.join(dataPath, entry.name));
  for (const childPath of children) assertNoReparseComponentsSync(childPath, fsApi);
  const deletionChildren = children.filter((childPath) => !sameCachePath(childPath, recordingPath)
    && (!recordingRoot || !pathContains(childPath, recordingRoot)));
  let recordingTemporary = null;
  if (retainedRecordingData) {
    recordingTemporary = `${recordingPath}.${process.pid}.${randomUUID()}.tmp`;
    assertNoReparseComponentsSync(recordingTemporary, fsApi);
    const descriptor = fsApi.openSync(recordingTemporary, 'wx', 0o600);
    try {
      fsApi.writeFileSync(descriptor, JSON.stringify(retainedRecordingData, null, 2), 'utf8');
      fsApi.fsyncSync(descriptor);
    } catch (error) {
      try { fsApi.unlinkSync(recordingTemporary); } catch { /* preserve the write error */ }
      throw error;
    } finally { fsApi.closeSync(descriptor); }
  }
  const removed = [];
  try {
    for (const childPath of deletionChildren) {
      fsApi.rmSync(childPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed.push(childPath);
    }
    if (recordingTemporary) fsApi.renameSync(recordingTemporary, recordingPath);
  } catch (error) {
    if (recordingTemporary) {
      try { fsApi.unlinkSync(recordingTemporary); } catch { /* preserve the reset error */ }
    }
    throw error;
  }
  return { removed };
}

/**
 * Prepare the cache before Electron selects userData. A reset happens only
 * for an actually newer opened version, a first-run migration with existing
 * legacy cache data, or the explicit maintenance flag. Same-version launches
 * are intentionally a no-op for cache contents.
 */
export function prepareArcPowerCacheSync(appDataPath, version, {
  forceReset = false,
  localAppDataPath = null,
  activeLockPath = null,
  beforeReset = null,
  fs: fsApi = DEFAULT_FS,
} = {}) {
  if (typeof version !== 'string' || !parseVersion(version)) {
    throw new TypeError('version must be a valid dotted release version');
  }
  if (beforeReset !== null && typeof beforeReset !== 'function') {
    throw new TypeError('beforeReset must be a function');
  }
  const resolvedLockPath = resolveActiveLockPath(activeLockPath);
  const cachePaths = resolveArcPowerCachePaths(appDataPath);
  const profilePath = path.join(appDataPath, 'ArcPower');
  const versionStatePath = resolveArcPowerVersionStatePath(appDataPath);
  assertNoReparseComponentsSync(versionStatePath, fsApi);
  const previousVersion = readLastOpenedVersion(versionStatePath, fsApi);
  const allCacheTargets = resolveArcPowerCacheTargets(appDataPath, { localAppDataPath });
  const hasExistingCache = allCacheTargets.some((cachePath) => fsApi.existsSync(cachePath))
    || ARC_POWER_PROFILE_CACHE_FILE_NAMES.some((fileName) => fsApi.existsSync(path.join(profilePath, fileName)));
  const versionChanged = previousVersion === null
    ? hasExistingCache
    : compareArcPowerVersions(version, previousVersion) > 0;
  const reset = forceReset || versionChanged;
  if (reset) {
    beforeReset?.();
    resetArcPowerCachesSync(appDataPath, { localAppDataPath, activeLockPath: resolvedLockPath, fs: fsApi });
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
  return argv.includes(CLEAR_CACHE_ARG) || readMaintenanceAction(argv) === 'clear-cache';
}

/** Resolve the one-shot maintenance action, retaining the legacy clear flag. */
export function readMaintenanceAction(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  const flags = argv.filter((arg) => typeof arg === 'string' && arg.startsWith(MAINTENANCE_ARG_PREFIX));
  if (argv.includes(CLEAR_CACHE_ARG) && flags.length) throw new Error('Arc Power maintenance action was provided more than once');
  if (flags.length > 1) throw new Error('Arc Power maintenance action was provided more than once');
  if (argv.includes(CLEAR_CACHE_ARG)) return 'clear-cache';
  const flag = flags[0];
  if (!flag) return null;
  const action = flag.slice(MAINTENANCE_ARG_PREFIX.length).split(':', 1)[0];
  if (!MAINTENANCE_ACTIONS.includes(action)) throw new Error('Arc Power maintenance action is invalid');
  return action;
}

export function readMaintenanceToken(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  const flag = argv.find((arg) => typeof arg === 'string' && arg.startsWith(MAINTENANCE_ARG_PREFIX));
  if (!flag) return null;
  const parts = flag.slice(MAINTENANCE_ARG_PREFIX.length).split(':');
  return parts.length === 2 && parts[1] ? parts[1] : null;
}

/** Remove reset-only flags before passing arguments to Electron relaunch. */
export function filterRelaunchArgs(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  return argv.filter((arg) => arg !== CLEAR_CACHE_ARG
    && !(typeof arg === 'string' && arg.startsWith(MAINTENANCE_ARG_PREFIX)));
}

/**
 * Build the one-shot cache reset relaunch options without touching Electron.
 *
 * A portable Electron process runs from the wrapper's temporary extraction
 * directory. When that process exits, the portable wrapper removes the
 * extraction directory, so Electron's default `process.execPath` is no longer
 * a valid relaunch target. Point portable packaged launches back at the stable
 * wrapper and leave dev/installed launches on Electron's normal executable.
 */
export function resolveCacheRestartRelaunchOptions({
  argv = [],
  isPackaged = false,
  platform = process.platform,
  portableWrapperPath = null,
  action = 'clear-cache',
  token = null,
} = {}) {
  if (!MAINTENANCE_ACTIONS.includes(action)) throw new Error('Arc Power maintenance action is invalid');
  if (action !== 'clear-cache' && (typeof token !== 'string' || token.length < 16)) throw new Error('confirmed reset token is required');
  const maintenanceArg = action === 'clear-cache' ? CLEAR_CACHE_ARG : `${MAINTENANCE_ARG_PREFIX}${action}:${token}`;
  const args = [...filterRelaunchArgs(argv), maintenanceArg];
  const usePortableWrapper = platform === 'win32'
    && isPackaged === true
    && typeof portableWrapperPath === 'string'
    && path.isAbsolute(portableWrapperPath);
  if (!usePortableWrapper) return Object.freeze({ args: Object.freeze(args) });
  return Object.freeze({
    args: Object.freeze(args),
    execPath: path.resolve(portableWrapperPath),
  });
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
