// Arc Power — M2b Run-key helper (apply-on-startup registration).
//
// Writes/deletes the HKCU Run key value `ArcPower`:
//   HKCU\Software\Microsoft\Windows\CurrentVersion\Run\ArcPower
//     = "<process.execPath>" --apply-profile <profileId>
// via `reg.exe` (execFile, no extra deps). HKCU needs no elevation and the
// helper only ever runs when the user flips the future UI toggle (IPC
// startup-set) — never at boot, never automatically.
//
// Mock mode: the IPC layer defaults to an in-memory fake (createMockStartup)
// so tests and --ui-verify never touch the real registry; the product path
// injects the real implementation (createStartup) in ipc.js.

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);

export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const RUN_VALUE = 'ArcPower';
// reg.exe exit code when the queried/deleted value does not exist.
export const REG_NOT_FOUND = 1;

/**
 * The exact command-line value stored in the Run key.
 * @param {string} execPath absolute path of the executable (quoted)
 * @param {string} profileId
 */
export function buildRunValue(execPath, profileId) {
  return `"${execPath}" --apply-profile ${profileId}`;
}

/**
 * Parse a stored Run value back into its parts (null when it is not an
 * Arc Power apply-profile entry).
 * @param {string} value
 * @returns {{ execPath: string, profileId: string } | null}
 */
export function parseRunValue(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^"([^"]+)"\s+--apply-profile\s+(\S+)$/);
  if (!m) return null;
  return { execPath: m[1], profileId: m[2] };
}

/**
 * Parse `reg query` stdout for the ArcPower value. Returns null when the
 * value is absent (exit 1 / not found), or when it is not ours.
 * @param {string} stdout
 * @param {number} [exitCode]
 * @returns {{ execPath: string, profileId: string } | null}
 */
export function parseRegQuery(stdout, exitCode = 0) {
  if (exitCode === REG_NOT_FOUND) return null;
  const m = String(stdout ?? '').match(/(?:REG_SZ|REG_EXPAND_SZ)\s+(.+)$/m);
  if (!m) return null;
  return parseRunValue(m[1].trim());
}

/**
 * Real Run-key adapter (reg.exe via injectable execFile for tests).
 * @param {{ execFile?: typeof execFile, execPath?: string }} [deps]
 */
export function createStartup(deps = {}) {
  const exec = deps.execFile ?? execFile;
  const execPath = deps.execPath ?? process.execPath;
  return {
    /**
     * @returns {Promise<{ enabled: boolean, profileId: string | null, value: string | null }>}
     */
    async get() {
      try {
        const { stdout } = await exec('reg', ['query', RUN_KEY, '/v', RUN_VALUE], { windowsHide: true });
        const parsed = parseRegQuery(stdout);
        return parsed
          ? { enabled: true, profileId: parsed.profileId, value: buildRunValue(parsed.execPath, parsed.profileId) }
          : { enabled: false, profileId: null, value: null };
      } catch (err) {
        if (err?.code === REG_NOT_FOUND) return { enabled: false, profileId: null, value: null };
        throw new Error(`startup query failed: ${err.message}`);
      }
    },
    /**
     * @param {boolean} enabled
     * @param {string | null} profileId
     */
    async set(enabled, profileId) {
      if (enabled) {
        if (!profileId) throw new Error('startup-set: profileId is required when enabling');
        const value = buildRunValue(execPath, profileId);
        await exec('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true });
        return { enabled: true, profileId, value };
      }
      try {
        await exec('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { windowsHide: true });
      } catch (err) {
        // Deleting an absent value (reg exit 1) is the desired end state.
        if (err?.code !== REG_NOT_FOUND) throw new Error(`startup delete failed: ${err.message}`);
      }
      return { enabled: false, profileId: null, value: null };
    },
  };
}

/**
 * In-memory fake — the default for tests, --ui-verify and mock mode; never
 * touches the registry and never spawns reg.exe.
 */
export function createMockStartup(initial = { enabled: false, profileId: null }) {
  let state = { enabled: initial.enabled === true, profileId: initial.profileId ?? null };
  const get = async () => (state.profileId
    ? { enabled: state.enabled, profileId: state.profileId, value: buildRunValue(process.execPath, state.profileId) }
    : { enabled: false, profileId: null, value: null });
  return {
    get,
    async set(enabled, profileId) {
      if (enabled) {
        if (!profileId) throw new Error('startup-set: profileId is required when enabling');
        state = { enabled: true, profileId };
      } else {
        state = { enabled: false, profileId: null };
      }
      return get();
    },
  };
}
