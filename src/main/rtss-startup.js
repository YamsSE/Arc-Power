// Unelevated per-user startup registration for third-party RTSS.
//
// This adapter deliberately owns a different HKCU Run value from Arc Power's
// startup registration. It only registers RTSS.exe; it never launches RTSS
// and never requests elevation.

import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { knownRtssExecutablePaths } from './rtss-install.js';

export const RTSS_STARTUP_VALUE_NAME = 'ArcPowerRTSS';
export const RTSS_STARTUP_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

const defaultExecFile = promisify(execFile);

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

export function createRtssStartup({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  execFileAsync = defaultExecFile,
  getRunningProcessImagePath,
} = {}) {
  const resolve = () => resolveRtssExecutablePath({ platform, env, exists, getRunningProcessImagePath: getRunningProcessImagePath ?? (() => defaultRunningRtssImagePath({ execFileAsync })) });
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

export function createMockRtssStartup({ executablePath = 'C:\\Program Files (x86)\\RivaTuner Statistics Server\\RTSS.exe', available = true, registered = false } = {}) {
  let state = { executablePath: available ? executablePath : null, registered };
  return {
    registrationMode: 'run',
    async get() {
      return { capable: state.executablePath !== null, executablePath: state.executablePath, valueExists: state.registered, value: state.registered ? quoteRunValue(state.executablePath) : null, registeredPath: state.registered ? state.executablePath : null, registered: state.registered };
    },
    async set(enabled) {
      if (enabled && !state.executablePath) throw new Error('rtss-startup: RTSS.exe was not found');
      state.registered = enabled;
      return this.get();
    },
  };
}
