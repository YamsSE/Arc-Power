// Arc Power - M2b-B driver-info helper (display-driver registry date).
//
// Reads the Windows display-driver `DriverDate` value (REG_SZ, "7-5-2026")
// from the display class registry key:
//   HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0000
// via `reg.exe` (execFile, no extra deps) - READ-ONLY, safe at boot. The
// lookup is best-effort: any failure (key absent, reg.exe missing, parse
// miss) returns `{ driverDate: null }` and the renderer falls back to
// showing the driver version without a date.
//
// Mock mode: the IPC layer defaults to an in-memory fake
// (createMockDriverInfo) so tests and --ui-verify never run reg.exe; the
// product path injects the real implementation in ipc.js.

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);

export const DISPLAY_CLASS_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
export const DRIVER_DATE_VALUE = 'DriverDate';
// reg.exe exit code when the queried value/key does not exist.
export const REG_NOT_FOUND = 1;

/**
 * Parse `reg query` stdout for the DriverDate value. Returns null when the
 * value is absent (exit 1 / not found) or unparseable.
 * @param {string} stdout e.g. "    DriverDate    REG_SZ    7-5-2026"
 * @param {number} [exitCode]
 * @returns {string | null}
 */
export function parseRegDriverDate(stdout, exitCode = 0) {
  if (exitCode === REG_NOT_FOUND) return null;
  const m = String(stdout ?? '').match(/DriverDate\s+REG_SZ\s+(\S+)/);
  return m ? m[1] : null;
}

/**
 * Real driver-info adapter (reg.exe via injectable execFile for tests).
 * Never throws - a failed lookup degrades to `{ driverDate: null }`.
 * @param {{ execFile?: typeof execFile, classKey?: string, adapterIndex?: number }} [deps]
 */
export function createDriverInfo(deps = {}) {
  const exec = deps.execFile ?? execFile;
  const classKey = deps.classKey ?? DISPLAY_CLASS_KEY;
  const adapterIndex = deps.adapterIndex ?? 0;
  const subKey = `${classKey}\\${String(adapterIndex).padStart(4, '0')}`;
  return {
    /**
     * @returns {Promise<{ driverDate: string | null }>}
     */
    async get() {
      try {
        const { stdout } = await exec('reg', ['query', subKey, '/v', DRIVER_DATE_VALUE], { windowsHide: true });
        return { driverDate: parseRegDriverDate(stdout) };
      } catch {
        // reg.exe failure (missing key/value, spawn error, timeout) is the
        // same null answer - the renderer falls back to the version alone.
        return { driverDate: null };
      }
    },
  };
}

/**
 * In-memory fake - the default for tests, --ui-verify and mock mode; never
 * runs reg.exe. Returns the fixture date (matches the real machine: driver
 * 32.0.101.8861, DriverDate 7-5-2026).
 * @param {string} [date]
 */
export function createMockDriverInfo(date = '7-5-2026') {
  return {
    get: async () => ({ driverDate: date }),
  };
}
