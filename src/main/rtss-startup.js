// Unelevated per-user startup registration for third-party RTSS.
//
// This adapter deliberately owns a different HKCU Run value from Arc Power's
// startup registration. The registration adapter never launches RTSS and
// never requests elevation. Immediate launch is a separate, explicit helper
// used only by the installer when the user asked to launch Arc Power.

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { mkdir as mkdirAsync, open as openAsync, rm as rmAsync, stat as statAsync } from 'node:fs/promises';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { knownRtssExecutablePaths, RTSS_EXE_NAME } from './rtss-install.js';

export const RTSS_STARTUP_VALUE_NAME = 'ArcPowerRTSS';
export const RTSS_STARTUP_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

const defaultExecFile = promisify(execFile);
let launchInFlight = null;
const defaultRealpath = realpathSync.native ?? realpathSync;
const DEFAULT_LAUNCH_LEASE_PATH = path.join(tmpdir(), 'ArcPower-rtss-launch.lock');

function quoteRunValue(filePath) {
  return `"${String(filePath).replaceAll('"', '')}"`;
}

function unquoteRunValue(value) {
  const text = String(value ?? '').trim();
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"')
    ? text.slice(1, -1)
    : text;
}

function samePath(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && left.trim().replaceAll('/', '\\').toLowerCase() === right.trim().replaceAll('/', '\\').toLowerCase();
}

function parseRegQuery(output) {
  const line = String(output ?? '').split(/\r?\n/).find((item) => {
    const trimmed = item.trim();
    return trimmed && new RegExp(`^${RTSS_STARTUP_VALUE_NAME}\\s+REG_`, 'i').test(trimmed);
  });
  if (!line) return null;
  const match = line.trim().match(new RegExp(`^${RTSS_STARTUP_VALUE_NAME}\\s+REG_\\w+\\s+(.*)$`, 'i'));
  return match ? match[1].trim() : null;
}

async function defaultRunningRtssImagePath({ execFileAsync = defaultExecFile } = {}) {
  try {
    const script = '$ErrorActionPreference = "SilentlyContinue"; (Get-CimInstance Win32_Process -Filter "Name = \'RTSS.exe\'").ExecutablePath | Select-Object -First 1';
    const result = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 });
    const path = String(result?.stdout ?? result ?? '').trim();
    return path || null;
  } catch {
    return null;
  }
}

function isRtssProcessImage(filePath) {
  return typeof filePath === 'string'
    && /(?:^|[\\/])RTSS\.exe$/i.test(filePath.trim());
}

async function defaultTrustedProgramFilesRoots({ execFileAsync = defaultExecFile } = {}) {
  try {
    const script = '[Environment]::GetFolderPath(\'ProgramFilesX86\'); [Environment]::GetFolderPath(\'ProgramFiles\')';
    const result = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 });
    return [...new Set(String(result?.stdout ?? result ?? '').split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => /^[A-Za-z]:\\[^\r\n]*$/.test(entry)))];
  } catch {
    return [];
  }
}

/** Resolve an existing RTSS.exe from standard locations, then a running image. */
export async function resolveRtssExecutablePath({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  getRunningProcessImagePath = defaultRunningRtssImagePath,
} = {}) {
  if (platform !== 'win32') return null;
  for (const candidate of knownRtssExecutablePaths(env)) {
    try { if (exists(candidate)) return candidate; } catch { /* keep probing */ }
  }
  try {
    const running = await getRunningProcessImagePath();
    if (typeof running === 'string' && /(?:^|[\\/])RTSS\.exe$/i.test(running.trim())) return running.trim();
  } catch { /* no process-image fallback */ }
  return null;
}

function isReparsePoint(stat) {
  return Boolean(
    stat?.isSymbolicLink?.()
    || stat?.isJunction?.()
    || stat?.isReparsePoint?.()
    || stat?.reparsePoint === true
    || stat?.attributes?.reparsePoint === true,
  );
}

function windowsPathComponents(filePath) {
  const value = String(filePath ?? '').trim().replaceAll('/', '\\');
  const parsed = path.win32.parse(value);
  if (!parsed.root) return [];
  const components = [parsed.root];
  let current = parsed.root;
  for (const segment of value.slice(parsed.root.length).split(/\\+/).filter(Boolean)) {
    current = path.win32.join(current, segment);
    components.push(current);
  }
  return components;
}

function hasReparsePointInPath(filePath, { realpath, lstat }) {
  const components = windowsPathComponents(filePath);
  if (components.length === 0) return true;
  for (const component of components) {
    let stat;
    try { stat = lstat(component); } catch { return true; }
    if (isReparsePoint(stat)) return true;
    // On Node builds where junctions are not exposed through Stats, native
    // realpath still reveals that a path component resolves elsewhere.
    try {
      if (!samePath(component, realpath(component))) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** A direct elevated spawn is safe only for the normal machine install roots. */
export function isTrustedRtssExecutablePath(filePath, _env = process.env, trustedRoots = [], { realpath = defaultRealpath, lstat = lstatSync } = {}) {
  const normalize = (value) => String(value ?? '').trim().replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
  const candidate = normalize(filePath);
  if (!candidate || !Array.isArray(trustedRoots) || trustedRoots.length === 0) return false;
  try {
    if (hasReparsePointInPath(filePath, { realpath, lstat })) return false;
    const canonicalCandidate = normalize(realpath(filePath));
    return trustedRoots
      .filter((root) => typeof root === 'string' && root.length > 0)
      .map((root) => path.win32.join(root, 'RivaTuner Statistics Server', RTSS_EXE_NAME))
      .filter((trustedPath) => !hasReparsePointInPath(trustedPath, { realpath, lstat }))
      .map((trustedPath) => normalize(realpath(trustedPath)))
      .some((trusted) => canonicalCandidate === trusted);
  } catch {
    return false;
  }
}

function launchDetail(error) {
  return String(error?.message ?? error ?? 'RTSS could not be started').replace(/\s+/g, ' ').slice(0, 240);
}

/**
 * Reserve the short probe-to-spawn window across separate installer
 * processes. The lease is deliberately a user-scoped temp file: it protects
 * duplicate optional launches, while the canonical Program Files check still
 * owns the security boundary for the executable itself.
 */
export async function acquireRtssLaunchLease({
  leasePath = DEFAULT_LAUNCH_LEASE_PATH,
  mkdir = mkdirAsync,
  openFile = openAsync,
  rmFile = rmAsync,
  statFile = statAsync,
  now = Date.now,
  staleAfterMs = 60_000,
} = {}) {
  try {
    await mkdir(path.dirname(leasePath), { recursive: true });
  } catch (error) {
    return { ok: false, reason: 'launch-lease-unavailable', detail: launchDetail(error) };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await openFile(leasePath, 'wx');
      return {
        ok: true,
        async release() {
          try { await handle.close(); } catch { /* already closed */ }
          try { await rmFile(leasePath, { force: true }); } catch { /* best effort cleanup */ }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { ok: false, reason: 'launch-lease-unavailable', detail: launchDetail(error) };
      }
      try {
        const info = await statFile(leasePath);
        if (Number.isFinite(info?.mtimeMs) && now() - info.mtimeMs > staleAfterMs) {
          await rmFile(leasePath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue;
      }
      return { ok: false, reason: 'launch-in-progress' };
    }
  }
  return { ok: false, reason: 'launch-in-progress' };
}

/**
 * Start RTSS for the install-completion handoff without changing the user's
 * independent HKCU Run preference. The installer is allowed to degrade when
 * RTSS is optional, so every discovery/launch failure is returned as data.
 */
async function launchRtssOnce({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  getRunningProcessImagePath = () => defaultRunningRtssImagePath(),
  getTrustedProgramFilesRoots = () => defaultTrustedProgramFilesRoots(),
  realpath = defaultRealpath,
  lstat = lstatSync,
  launchLeasePath = DEFAULT_LAUNCH_LEASE_PATH,
  acquireLease = acquireRtssLaunchLease,
  mkdir = mkdirAsync,
  openFile = openAsync,
  rmFile = rmAsync,
  statFile = statAsync,
  spawnProcess = nodeSpawn,
  allowUserWritablePath = false,
} = {}) {
  const base = { started: false, alreadyRunning: false, executablePath: null };
  if (platform !== 'win32') return { ...base, reason: 'windows-only' };

  try {
    const running = await getRunningProcessImagePath();
    if (typeof running === 'string' && /(?:^|[\\/])RTSS\.exe$/i.test(running.trim())) {
      return { ...base, alreadyRunning: true, executablePath: running.trim(), reason: 'already-running' };
    }
  } catch {
    // A failed process probe is not a reason to block an optional provider;
    // path discovery below still gets a chance to start RTSS.
  }

  const executablePath = await resolveRtssExecutablePath({
    platform,
    env,
    exists,
    getRunningProcessImagePath,
  });
  if (!executablePath) return { ...base, reason: 'executable-not-found' };
  if (!allowUserWritablePath) {
    let trustedRoots = [];
    try { trustedRoots = await getTrustedProgramFilesRoots(); } catch { /* fail closed below */ }
    if (!isTrustedRtssExecutablePath(executablePath, env, trustedRoots, { realpath, lstat })) {
      return { ...base, executablePath, reason: 'untrusted-location' };
    }
  }

  const lease = await acquireLease({ leasePath: launchLeasePath, mkdir, openFile, rmFile, statFile });
  if (lease?.ok !== true) return { ...base, executablePath, reason: lease?.reason ?? 'launch-lease-unavailable', ...(lease?.detail ? { detail: lease.detail } : {}) };
  try {
    // Close the probe-to-spawn window while holding the cross-process lease.
    try {
      const running = await getRunningProcessImagePath();
      if (typeof running === 'string' && /(?:^|[\\/])RTSS\.exe$/i.test(running.trim())) {
        return { ...base, alreadyRunning: true, executablePath: running.trim(), reason: 'already-running' };
      }
    } catch {
      // Keep the optional provider non-fatal when the second probe is unavailable.
    }

    let child;
    try {
      child = spawnProcess(executablePath, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
    } catch (error) {
      return { ...base, executablePath, reason: 'launch-failed', detail: launchDetail(error) };
    }

    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      child?.once?.('error', (error) => finish({ ...base, executablePath, reason: 'launch-failed', detail: launchDetail(error) }));
      child?.once?.('spawn', () => {
        try { child.unref?.(); } catch { /* the process is already detached */ }
        finish({ started: true, alreadyRunning: false, executablePath, reason: 'started' });
      });
      if (!child?.once) finish({ ...base, executablePath, reason: 'launch-failed', detail: 'RTSS launch did not return a child process.' });
    });
  } finally {
    await lease.release?.();
  }
}

export function launchRtss(options = {}) {
  if (launchInFlight) return launchInFlight;
  launchInFlight = launchRtssOnce(options).finally(() => {
    launchInFlight = null;
  });
  return launchInFlight;
}

export function createRtssStartup({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  execFileAsync = defaultExecFile,
  getRunningProcessImagePath,
} = {}) {
  const getRunningImage = getRunningProcessImagePath ?? (() => defaultRunningRtssImagePath({ execFileAsync }));
  const resolve = () => resolveRtssExecutablePath({ platform, env, exists, getRunningProcessImagePath: getRunningImage });
  const query = async () => {
    if (platform !== 'win32') return null;
    try {
      const result = await execFileAsync('reg.exe', ['query', RTSS_STARTUP_KEY, '/v', RTSS_STARTUP_VALUE_NAME], { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 });
      return parseRegQuery(result?.stdout ?? result);
    } catch (error) {
      if (error?.code === 1 || /unable to find|not found/i.test(String(error?.stderr ?? error?.message ?? ''))) return null;
      throw error;
    }
  };
  const get = async () => {
    const value = await query();
    const registeredPath = unquoteRunValue(value);
    let executablePath = await resolve();
    // A custom RTSS installation may no longer be running, so the normal
    // location/process probes can be empty even though our own registration
    // still identifies the executable. Reuse that path only when it is a
    // real RTSS image; a missing file remains a removable stale registration.
    if (!executablePath && /(?:^|[\\/])RTSS\.exe$/i.test(registeredPath)) {
      try {
        if (exists(registeredPath)) executablePath = registeredPath;
      } catch { /* stale registration remains visible through valueExists */ }
    }
    return {
      capable: platform === 'win32' && executablePath !== null,
      executablePath,
      valueExists: value !== null,
      value,
      registeredPath: registeredPath || null,
      registered: executablePath !== null && samePath(registeredPath, executablePath),
    };
  };
  return {
    registrationMode: 'run',
    get,
    async isRunning() {
      if (platform !== 'win32') return false;
      try {
        return isRtssProcessImage(await getRunningImage());
      } catch {
        return false;
      }
    },
    async set(enabled) {
      if (typeof enabled !== 'boolean') throw new Error('rtss-startup: enabled must be a boolean');
      if (platform !== 'win32') throw new Error('rtss-startup: Windows is required');
      if (enabled) {
        const executablePath = (await get()).executablePath;
        if (!executablePath) throw new Error('rtss-startup: RTSS.exe was not found');
        await execFileAsync('reg.exe', ['add', RTSS_STARTUP_KEY, '/v', RTSS_STARTUP_VALUE_NAME, '/t', 'REG_SZ', '/d', quoteRunValue(executablePath), '/f'], { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 });
        const state = await get();
        if (!state.registered) throw new Error('rtss-startup: registration could not be verified');
        return state;
      }
      try {
        await execFileAsync('reg.exe', ['delete', RTSS_STARTUP_KEY, '/v', RTSS_STARTUP_VALUE_NAME, '/f'], { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 });
      } catch (error) {
        if (error?.code !== 1 && !/unable to find|not found/i.test(String(error?.stderr ?? error?.message ?? ''))) throw new Error(`rtss-startup: registry removal failed: ${error?.message ?? error}`);
      }
      const state = await get();
      if (state.valueExists) throw new Error('rtss-startup: registration removal could not be verified');
      return state;
    },
  };
}

export function createMockRtssStartup({ executablePath = 'C:\\Program Files (x86)\\RivaTuner Statistics Server\\RTSS.exe', available = true, registered = false, running = available } = {}) {
  let state = { executablePath: available ? executablePath : null, registered, running: available && running === true };
  return {
    registrationMode: 'run',
    async get() {
      return { capable: state.executablePath !== null, executablePath: state.executablePath, valueExists: state.registered, value: state.registered ? quoteRunValue(state.executablePath) : null, registeredPath: state.registered ? state.executablePath : null, registered: state.registered };
    },
    async isRunning() { return state.executablePath !== null && state.running === true; },
    async set(enabled) {
      if (enabled && !state.executablePath) throw new Error('rtss-startup: RTSS.exe was not found');
      state.registered = enabled;
      return this.get();
    },
  };
}
