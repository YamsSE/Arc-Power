// Arc Power — M2b/M2C-C apply-on-startup registration.
//
// M2b: HKCU Run key (ArcPower = "<exe>" --apply-profile <id>) via reg.exe.
// M2C-C: OC writes persist ONLY from an elevated client, so boot applies
// must run elevated — the Run key is replaced by a SCHEDULED TASK with
// /rl highest (elevated at logon, silently):
//   schtasks /create /tn ArcPowerApplyOnBoot /sc onlogon /rl highest
//            /tr "<exe>" --apply-profile <id> /f
// Creating the task needs ONE UAC at enable time (spawned elevated helper);
// disable deletes the task (elevated) + cleans the Run key. startup-get
// reports which mechanism is active (task first, Run key fallback).
//
// Mock mode: the IPC layer defaults to an in-memory fake (createMockStartup)
// so tests and --ui-verify never touch the real registry/scheduler; the
// product path injects the real implementation (createStartup) in ipc.js.

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildElevatedLaunch, classifyElevationError } from './igs-service.js';

const execFile = promisify(nodeExecFile);

const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const RUN_VALUE = 'ArcPower';
export const TASK_NAME = 'ArcPowerApplyOnBoot';
// reg.exe exit code when the queried/deleted value does not exist.
export const REG_NOT_FOUND = 1;
// schtasks.exe exit code for "the task does not exist".
export const SCHTASKS_TASK_NOT_FOUND = 0x41303;
// PowerShell exit code on a UAC decline (Start-Process -Verb RunAs failure).
export const ERROR_CANCELLED_CODE = 1223;

/**
 * The exact command-line value stored in the Run key / task action.
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
 * Parse `schtasks /query /tn <task> /fo LIST /v` stdout for the task's
 * "Task To Run" command line. Returns null when the task does not exist
 * (exit code 0x41303 / 0x41301) or its action is not ours.
 * @param {string} stdout
 * @param {number} [exitCode]
 * @returns {{ execPath: string, profileId: string } | null}
 */
export function parseSchTasksQuery(stdout, exitCode = 0) {
  if (exitCode === SCHTASKS_TASK_NOT_FOUND || exitCode === 0x41301) return null;
  const m = String(stdout ?? '').match(/^Task To Run:\s+(.+)$/m);
  if (!m) return null;
  return parseRunValue(m[1].trim());
}

/**
 * PowerShell single-quoted-literal escaping (M3): a `'` inside a
 * single-quoted PowerShell string must be doubled. Same rule as
 * buildWorkerLaunch (elevated-apply.js) — the startup task scripts
 * interpolate execPath/profileId into single-quoted literals too.
 * @param {string} s
 */
export function psSingleQuote(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * The elevated PowerShell script that CREATES the boot task.
 * @param {string} execPath absolute path of our executable
 * @param {string} profileId
 */
export function buildTaskCreateScript(execPath, profileId) {
  const tr = psSingleQuote(buildRunValue(execPath, profileId));
  return [
    `$tr = '${tr}'`,
    `& schtasks /create /tn ${TASK_NAME} /sc onlogon /rl highest /tr $tr /f | Out-Null`,
    'exit $LASTEXITCODE',
  ].join('; ');
}

/**
 * The elevated PowerShell script that DELETES the boot task (exit 0 when it
 * never existed — deleting an absent task is the desired end state).
 */
export function buildTaskDeleteScript() {
  return [
    `& schtasks /delete /tn ${TASK_NAME} /f | Out-Null`,
    'if ($LASTEXITCODE -ne 0) { exit 0 }',
    'exit 0',
  ].join('; ');
}

/**
 * Run one elevated command (the schtasks create/delete needs admin — ONE
 * UAC per enable/disable). Returns the result of the elevated helper;
 * a UAC decline surfaces as `{ ok: false, error }` (never a crash).
 * `exec` is injectable for tests; the real implementation never runs in
 * mock mode.
 * @param {string} script
 * @param {{ exec?: typeof execFile }} [deps]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function runElevatedTaskCommand(script, { exec = execFile } = {}) {
  try {
    await exec(POWERSHELL_EXE, ['-NoProfile', '-Command', buildElevatedLaunch(script)], {
      windowsHide: true,
      timeout: 120000,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: classifyElevationError(err) };
  }
}

/**
 * Real adapter (reg.exe + schtasks via injectable execFile for tests).
 * @param {{
 *   execFile?: typeof execFile,
 *   execPath?: string,
 *   runElevated?: (script: string) => Promise<{ ok: boolean, error?: string }>,
 * }} [deps]
 */
export function createStartup(deps = {}) {
  const exec = deps.execFile ?? execFile;
  const execPath = deps.execPath ?? process.execPath;
  const runElevated = deps.runElevated ?? runElevatedTaskCommand;
  return {
    /**
     * @returns {Promise<{ enabled: boolean, profileId: string | null, value: string | null, mechanism: 'task' | 'run-key' | null }>}
     */
    async get() {
      // 1. scheduled task (the M2C-C mechanism) — read-only query.
      try {
        const { stdout } = await exec('schtasks', ['/query', '/tn', TASK_NAME, '/fo', 'LIST', '/v'], { windowsHide: true });
        const parsed = parseSchTasksQuery(stdout);
        if (parsed) {
          return { enabled: true, profileId: parsed.profileId, value: buildRunValue(parsed.execPath, parsed.profileId), mechanism: 'task' };
        }
      } catch {
        // schtasks errors (task absent / not queryable) fall through to the
        // Run-key fallback — never fail the query on the task half.
      }
      // 2. Run key fallback (the M2b mechanism).
      try {
        const { stdout } = await exec('reg', ['query', RUN_KEY, '/v', RUN_VALUE], { windowsHide: true });
        const parsed = parseRegQuery(stdout);
        return parsed
          ? { enabled: true, profileId: parsed.profileId, value: buildRunValue(parsed.execPath, parsed.profileId), mechanism: 'run-key' }
          : { enabled: false, profileId: null, value: null, mechanism: null };
      } catch (err) {
        if (err?.code === REG_NOT_FOUND) return { enabled: false, profileId: null, value: null, mechanism: null };
        throw new Error(`startup query failed: ${err.message}`);
      }
    },
    /**
     * Enable = create the elevated boot task (ONE UAC at enable — the task
     * then runs elevated at every logon silently) + clean the Run key.
     * Disable = delete the task + the Run key.
     * @param {boolean} enabled
     * @param {string | null} profileId
     */
    async set(enabled, profileId) {
      if (enabled) {
        if (!profileId) throw new Error('startup-set: profileId is required when enabling');
        const out = await runElevated(buildTaskCreateScript(execPath, profileId));
        if (!out.ok) {
          throw new Error(`startup-set: ${out.error ?? 'task creation failed'}`);
        }
        // Clean the legacy Run key so both mechanisms never fight.
        try {
          await exec('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { windowsHide: true });
        } catch { /* best effort */ }
        return { enabled: true, profileId, value: buildRunValue(execPath, profileId), mechanism: 'task' };
      }
      // Disable: delete the task (elevated; absent task = success) + the
      // Run key (non-elevated; absent value = success).
      const out = await runElevated(buildTaskDeleteScript());
      if (!out.ok) {
        throw new Error(`startup-set: ${out.error ?? 'task deletion failed'}`);
      }
      try {
        await exec('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { windowsHide: true });
      } catch (err) {
        if (err?.code !== REG_NOT_FOUND) throw new Error(`startup delete failed: ${err.message}`);
      }
      return { enabled: false, profileId: null, value: null, mechanism: null };
    },
  };
}

/**
 * In-memory fake — the default for tests, --ui-verify and mock mode; never
 * touches the registry, the scheduler or the UAC prompt.
 */
export function createMockStartup(initial = { enabled: false, profileId: null }) {
  let state = { enabled: initial.enabled === true, profileId: initial.profileId ?? null };
  const get = async () => (state.profileId
    ? { enabled: state.enabled, profileId: state.profileId, value: buildRunValue(process.execPath, state.profileId), mechanism: state.enabled ? 'task' : null }
    : { enabled: false, profileId: null, value: null, mechanism: null });
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
