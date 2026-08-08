// Arc Power - M4-D2 startup registration: the HKCU Run value ONLY.
//
// M2b/M2C-C used scheduled tasks (onlogon /rl highest) for start-with-
// Windows + apply-on-boot - every enable/disable UAC'd, and the user
// declined, so "none of them work" (M4-D2 §12 root cause b). Tasks are
// GONE. The ONLY registration is the HKCU Run value:
//   HKCU\Software\Microsoft\Windows\CurrentVersion\Run\ArcPower = "<exe>"
// via reg.exe - zero UAC, unelevated, HKCU-only.
//
// "Active" = the value exists. ONE value serves both toggles: the
// Settings "Start with Windows" toggle and the Profiles "start at boot"
// toggle both write it (the in-app boot apply handles the apply - the
// bare "<exe>" launch runs the UI, which applies the active profile at
// boot when ocOnBoot is set). The startup adapter stays DUMB (raw
// { valueExists, value }); ipc-core's startup-get composes the
// { startWithWindows, applyOnBoot } derivation from its own store read.
//
// Mock mode: createMockStartup() is the default for tests and --ui-verify
// (in-memory, never touches the registry); the product path injects
// createStartup in ipc.js/main.js.

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);

export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const RUN_VALUE = 'ArcPower';
// reg.exe exit code when the queried/deleted value does not exist.
export const REG_NOT_FOUND = 1;

/**
 * The exact command-line value stored in the Run key: the bare quoted
 * executable - no --apply-profile (the app boots into the UI, which owns
 * the boot apply).
 * @param {string} execPath absolute path of the executable (quoted)
 */
export function buildRunValue(execPath) {
  return `"${execPath}"`;
}

/**
 * Parse a stored Run value back into its parts (null when it is not an
 * Arc Power entry - i.e. not exactly the bare quoted executable).
 * @param {string} value
 * @returns {{ execPath: string } | null}
 */
export function parseRunValue(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^"([^"]+)"$/);
  if (!m) return null;
  return { execPath: m[1] };
}

/**
 * Parse `reg query` stdout for the ArcPower value. Returns null when the
 * value is absent (exit 1 / not found) or when it is not ours.
 * @param {string} stdout
 * @param {number} [exitCode]
 * @returns {{ execPath: string } | null}
 */
export function parseRegQuery(stdout, exitCode = 0) {
  if (exitCode === REG_NOT_FOUND) return null;
  const m = String(stdout ?? '').match(/(?:REG_SZ|REG_EXPAND_SZ)\s+(.+)$/m);
  if (!m) return null;
  return parseRunValue(m[1].trim());
}

/**
 * M4-D2 (packaged story): the Run value must survive a reboot. The
 * electron-builder PORTABLE exe extracts the app to a temp dir and spawns
 * it - `process.execPath` is that temp extraction, which is gone after a
 * reboot. The stable logon target is the OUTER portable exe (the app's
 * parent process). When the parent's exe basename matches the portable
 * artifact naming (Arc-Power-*.exe), use the parent's path; otherwise
 * process.execPath (dev tree / win-unpacked / installed builds). One
 * unelevated read-only PowerShell query, at startup-set time.
 * @param {{
 *   execFile?: typeof execFile,
 *   ppid?: number,
 *   isPackaged?: boolean,
 *   execPath?: string,
 * }} [deps]
 * @returns {Promise<string>}
 */
export async function resolveLogonExecPath(deps = {}) {
  const exec = deps.execFile ?? execFile;
  const execPath = deps.execPath ?? process.execPath;
  if (deps.isPackaged === false) return execPath;
  const ppid = deps.ppid ?? process.ppid;
  if (!ppid) return execPath;
  try {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${ppid}").ExecutablePath`;
    const { stdout } = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 8000 },
    );
    const parent = String(stdout ?? '').trim();
    if (!parent) return execPath;
    if (/arc[-\s_]?power/i.test(parent.split(/[\\/]/).pop() ?? '') && parent !== execPath) {
      return parent;
    }
  } catch {
    // parent query failed - fall back to process.execPath
  }
  return execPath;
}

/**
 * Real adapter (reg.exe via injectable execFile for tests). The Run value
 * is written/removed unelevated - NEVER any elevated helper, NEVER a UAC
 * (M4-D2 hard constraint). The value points at the LOGON-STABLE executable
 * (M4-D2: the portable wrapper exe when packaged, else process.execPath).
 * @param {{
 *   execFile?: typeof execFile,
 *   execPath?: string,
 *   logonExecPath?: string,
 * }} [deps]
 */
export function createStartup(deps = {}) {
  const exec = deps.execFile ?? execFile;
  const execPath = deps.logonExecPath ?? deps.execPath ?? process.execPath;
  return {
    /**
     * The raw registry truth: whether our Run value exists and its value.
     * A query failure (absent value -> exit 1, or any other error)
     * degrades to valueExists:false - the read is never a boot blocker.
     * @returns {Promise<{ valueExists: boolean, value: string | null }>}
     */
    async get() {
      try {
        const { stdout } = await exec('reg', ['query', RUN_KEY, '/v', RUN_VALUE], { windowsHide: true });
        const parsed = parseRegQuery(stdout);
        return parsed
          ? { valueExists: true, value: buildRunValue(parsed.execPath) }
          : { valueExists: false, value: null };
      } catch (err) {
        if (err?.code === REG_NOT_FOUND) return { valueExists: false, value: null };
        // Any other query failure (reg.exe missing, key unreadable):
        // degrade to absent - never fail the read.
        return { valueExists: false, value: null };
      }
    },
    /**
     * Enable = write the bare-quoted-exe Run value (unelevated reg.exe,
     * zero UAC); disable = delete it (absent value = success).
     * @param {boolean} enabled
     * @returns {Promise<{ valueExists: boolean, value: string | null }>}
     */
    async set(enabled) {
      if (enabled) {
        try {
          await exec('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', buildRunValue(execPath), '/f'], { windowsHide: true });
        } catch (err) {
          throw new Error(`startup-set: reg add failed: ${err.message}`);
        }
        return this.get();
      }
      try {
        await exec('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { windowsHide: true });
      } catch (err) {
        if (err?.code !== REG_NOT_FOUND) throw new Error(`startup-set: reg delete failed: ${err.message}`);
      }
      return this.get();
    },
  };
}

/**
 * In-memory fake - the default for tests, --ui-verify and mock mode;
 * never touches the registry, never spawns anything.
 * @param {{ valueExists?: boolean }} [initial]
 */
export function createMockStartup(initial = {}) {
  let valueExists = initial.valueExists === true;
  const get = async () => ({
    valueExists,
    value: valueExists ? buildRunValue(process.execPath) : null,
  });
  return {
    get,
    async set(enabled) {
      valueExists = enabled === true;
      return get();
    },
  };
}
