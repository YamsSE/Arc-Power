// Arc Power — M2b/M2C-C apply-on-startup registration + M4-D plain-app
// scheduled task (the Settings "Start with Windows" toggle).
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
// M4-D (plain-app variant): the Settings "Start with Windows" toggle uses
// the SAME onlogon /rl highest mechanism with its OWN task
// (ArcPowerAppOnBoot) launching the exe WITHOUT --apply-profile — the
// packaged EXE is always-elevated (M3-C-B), so a plain Run key would UAC at
// EVERY logon; the task runs elevated silently. COEXISTENCE RULE
// (Round-1 F4): both tasks are onlogon /rl highest — both enabled would
// launch the app twice at logon, so the two registrations can never be
// enabled together: enabling one deletes the other inside the SAME elevated
// call (still ONE UAC). startup-get reports BOTH distinctly:
//   { startupRunKey: {...}, applyOnBoot: { enabled, value },
//     startWithWindows: boolean }
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
// M4-D: the plain-app task (Settings "Start with Windows").
export const APP_TASK_NAME = 'ArcPowerAppOnBoot';
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
 * M4-D: the plain-app task action — the bare quoted executable, NO
 * --apply-profile (the app boots into the UI, not into a profile apply).
 * @param {string} execPath absolute path of the executable (quoted)
 */
export function buildAppRunValue(execPath) {
  return `"${execPath}"`;
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
 * M4-D: parse a stored value back into a plain-app entry (exactly the bare
 * quoted executable — an --apply-profile value is NOT a plain entry).
 * @param {string} value
 * @returns {{ execPath: string } | null}
 */
export function parseAppRunValue(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^"([^"]+)"$/);
  if (!m) return null;
  return { execPath: m[1] };
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
 * M4-D: parse `schtasks /query` stdout for the PLAIN-app task's "Task To
 * Run" line. Returns null when the task does not exist or its action is not
 * the plain app entry (an --apply-profile action is NOT a plain entry).
 * @param {string} stdout
 * @param {number} [exitCode]
 * @returns {{ execPath: string } | null}
 */
export function parseSchTasksAppQuery(stdout, exitCode = 0) {
  if (exitCode === SCHTASKS_TASK_NOT_FOUND || exitCode === 0x41301) return null;
  const m = String(stdout ?? '').match(/^Task To Run:\s+(.+)$/m);
  if (!m) return null;
  return parseAppRunValue(m[1].trim());
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
 * The elevated PowerShell script that CREATES the boot task. M4-D
 * coexistence: the plain-app task (ArcPowerAppOnBoot) is DELETED by the
 * same elevated call — the two onlogon tasks cannot both be enabled
 * (Round-1 F4), and the delete must not cost a second UAC. The delete is
 * GATED on the create's success (M4-D review F2): a failed create must
 * leave the other registration untouched — the coexistence disable is only
 * legitimate when the enable actually landed. The script exits with the
 * CREATE's exit code (the delete outcome is best-effort: an absent app
 * task is the desired end state; a failed delete leaves it for the next
 * disable to clean).
 * @param {string} execPath absolute path of our executable
 * @param {string} profileId
 */
export function buildTaskCreateScript(execPath, profileId) {
  const tr = psSingleQuote(buildRunValue(execPath, profileId));
  return [
    `$tr = '${tr}'`,
    `& schtasks /create /tn ${TASK_NAME} /sc onlogon /rl highest /tr $tr /f | Out-Null`,
    '$createCode = $LASTEXITCODE',
    `if ($createCode -eq 0) { & schtasks /delete /tn ${APP_TASK_NAME} /f | Out-Null }`,
    'exit $createCode',
  ].join('; ');
}

/**
 * M4-D: the elevated PowerShell script that CREATES the plain-app task
 * (ArcPowerAppOnBoot, onlogon /rl highest, no --apply-profile). The
 * apply-profile task (ArcPowerApplyOnBoot) is deleted in the same elevated
 * call — coexistence (ONE UAC), same exit-code discipline and the same
 * create-success gate on the delete (M4-D review F2) as
 * buildTaskCreateScript.
 * @param {string} execPath absolute path of our executable
 */
export function buildAppTaskCreateScript(execPath) {
  const tr = psSingleQuote(buildAppRunValue(execPath));
  return [
    `$tr = '${tr}'`,
    `& schtasks /create /tn ${APP_TASK_NAME} /sc onlogon /rl highest /tr $tr /f | Out-Null`,
    '$createCode = $LASTEXITCODE',
    `if ($createCode -eq 0) { & schtasks /delete /tn ${TASK_NAME} /f | Out-Null }`,
    'exit $createCode',
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
 * M4-D: the elevated PowerShell script that DELETES the plain-app task
 * (absent task = success, same rule as buildTaskDeleteScript).
 */
export function buildAppTaskDeleteScript() {
  return [
    `& schtasks /delete /tn ${APP_TASK_NAME} /f | Out-Null`,
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
     * M4-D: report BOTH registrations distinctly — the apply-profile one
     * (task ArcPowerApplyOnBoot first, legacy Run key fallback) AND the
     * plain-app task (ArcPowerAppOnBoot). A query failure on either half
     * degrades that half to disabled — the read is never a boot blocker.
     * @returns {Promise<{
     *   startupRunKey: { enabled: boolean, profileId: string | null, value: string | null, mechanism: 'task' | 'run-key' | null },
     *   applyOnBoot: { enabled: boolean, value: string | null },
     *   startWithWindows: boolean,
     * }>}
     */
    async get() {
      // 1. the apply-profile registration (the M2C-C task, then the M2b
      // Run-key fallback) — the Profiles page's start-at-boot toggle.
      let runKey = { enabled: false, profileId: null, value: null, mechanism: null };
      try {
        const { stdout } = await exec('schtasks', ['/query', '/tn', TASK_NAME, '/fo', 'LIST', '/v'], { windowsHide: true });
        const parsed = parseSchTasksQuery(stdout);
        if (parsed) {
          runKey = { enabled: true, profileId: parsed.profileId, value: buildRunValue(parsed.execPath, parsed.profileId), mechanism: 'task' };
        }
      } catch {
        // schtasks errors (task absent / not queryable) fall through to the
        // Run-key fallback — never fail the query on the task half.
      }
      if (!runKey.enabled) {
        try {
          const { stdout } = await exec('reg', ['query', RUN_KEY, '/v', RUN_VALUE], { windowsHide: true });
          const parsed = parseRegQuery(stdout);
          if (parsed) {
            runKey = { enabled: true, profileId: parsed.profileId, value: buildRunValue(parsed.execPath, parsed.profileId), mechanism: 'run-key' };
          }
        } catch (err) {
          if (err?.code === REG_NOT_FOUND) runKey = { enabled: false, profileId: null, value: null, mechanism: null };
          else throw new Error(`startup query failed: ${err.message}`);
        }
      }
      // 2. the plain-app task (M4-D Settings "Start with Windows"). Any
      // query failure degrades to disabled — the task simply isn't there.
      let appOnBoot = { enabled: false, value: null };
      try {
        const { stdout } = await exec('schtasks', ['/query', '/tn', APP_TASK_NAME, '/fo', 'LIST', '/v'], { windowsHide: true });
        const parsed = parseSchTasksAppQuery(stdout);
        if (parsed) appOnBoot = { enabled: true, value: buildAppRunValue(parsed.execPath) };
      } catch {
        // absent / not queryable -> disabled.
      }
      return { startupRunKey: runKey, applyOnBoot: appOnBoot, startWithWindows: appOnBoot.enabled };
    },
    /**
     * Enable = create the elevated boot task (ONE UAC at enable — the task
     * then runs elevated at every logon silently; the plain-app task is
     * deleted in the SAME elevated call, coexistence) + clean the Run key.
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
        return this.get();
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
      return this.get();
    },
    /**
     * M4-D: enable/disable the plain-app task (ArcPowerAppOnBoot, no
     * --apply-profile). Enabling deletes the apply-profile task in the SAME
     * elevated call (coexistence — the two tasks cannot both be enabled)
     * and cleans the legacy Run key; disabling only deletes the app task.
     * @param {boolean} enabled
     */
    async setAppOnBoot(enabled) {
      if (enabled) {
        const out = await runElevated(buildAppTaskCreateScript(execPath));
        if (!out.ok) {
          throw new Error(`startup-app-set: ${out.error ?? 'task creation failed'}`);
        }
        // Clean the legacy Run key (the apply-profile registration is gone).
        try {
          await exec('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { windowsHide: true });
        } catch { /* best effort */ }
        return this.get();
      }
      const out = await runElevated(buildAppTaskDeleteScript());
      if (!out.ok) {
        throw new Error(`startup-app-set: ${out.error ?? 'task deletion failed'}`);
      }
      return this.get();
    },
  };
}

/**
 * In-memory fake — the default for tests, --ui-verify and mock mode; never
 * touches the registry, the scheduler or the UAC prompt. M4-D: mirrors the
 * coexistence rule — enabling one registration disables the other.
 * @param {{ enabled?: boolean, profileId?: string | null, appOnBoot?: boolean }} [initial]
 */
export function createMockStartup(initial = { enabled: false, profileId: null }) {
  let state = { enabled: initial.enabled === true, profileId: initial.profileId ?? null };
  let appOnBoot = initial.appOnBoot === true;
  const get = async () => {
    const runKey = state.profileId
      ? { enabled: state.enabled, profileId: state.profileId, value: buildRunValue(process.execPath, state.profileId), mechanism: state.enabled ? 'task' : null }
      : { enabled: false, profileId: null, value: null, mechanism: null };
    return {
      startupRunKey: runKey,
      applyOnBoot: { enabled: appOnBoot, value: appOnBoot ? buildAppRunValue(process.execPath) : null },
      startWithWindows: appOnBoot,
    };
  };
  return {
    get,
    async set(enabled, profileId) {
      if (enabled) {
        if (!profileId) throw new Error('startup-set: profileId is required when enabling');
        state = { enabled: true, profileId };
        // M4-D coexistence: enabling the apply-profile registration
        // disables the plain-app task (both cannot be enabled).
        appOnBoot = false;
      } else {
        state = { enabled: false, profileId: null };
      }
      return get();
    },
    async setAppOnBoot(enabled) {
      appOnBoot = enabled === true;
      if (appOnBoot) {
        // M4-D coexistence: enabling the app task disables the apply-profile
        // registration.
        state = { enabled: false, profileId: null };
      }
      return get();
    },
  };
}
