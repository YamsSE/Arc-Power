// Arc Power startup registration. Dev/mock uses the HKCU Run value with a
// one-time cleanup of legacy portable registrations. Packaged Windows builds
// request administrator access, and Explorer cannot reliably consent that
// manifest from HKCU Run during logon, so they use an explicitly approved
// per-user onlogon task (ArcPowerStartup) whose action targets the stable
// installed executable or portable wrapper. The existing ArcPowerBootApply
// task remains a separate apply-on-boot compatibility path.
//
// "Active" means the selected registration was read back successfully. ONE
// registration serves both toggles: the Settings "Start with Windows" toggle
// and the Profiles "start at boot" toggle both write it (the app boot path
// handles the apply). The startup adapter returns raw { valueExists, value }
// plus registration:'task' for the packaged path; ipc-core's startup-get
// composes { startWithWindows, applyOnBoot } from its own store read.
//
// Mock mode: createMockStartup() is the default for tests and --ui-verify
// (in-memory, never touches the registry); the product path injects
// createStartup in ipc.js/main.js.

import { execFile as nodeExecFile } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import { promisify } from 'node:util';
import { POWERSHELL_EXE } from './elevated-apply.js';
import { decodeTaskXml, parseTaskXml } from './setup-boot.js';

const execFile = promisify(nodeExecFile);

export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const RUN_VALUE = 'ArcPower';
// Packaged Windows builds request administrator access. Explorer's HKCU Run
// launcher cannot reliably consent an elevated executable during logon, so
// those builds use this per-user elevated logon task after an explicit UAC
// setup. The existing ArcPowerBootApply task remains a separate apply-on-boot
// compatibility path for installed builds.
export const STARTUP_TASK_NAME = 'ArcPowerStartup';
// M4-D/M2C-C registrations left by older portable builds. Do not remove
// ArcPowerBootApply: that is the current installed-build profile task.
export const LEGACY_TASK_NAMES = ['ArcPowerAppOnBoot', 'ArcPowerApplyOnBoot'];
// Electron's former app.setLoginItemSettings registration used the product
// name as the Run value name. The current ArcPower value is retained for
// compatibility with releases since M4-D2.
export const LEGACY_RUN_VALUE_NAMES = ['Arc Power'];
// reg.exe exit code when the queried/deleted value does not exist.
export const REG_NOT_FOUND = 1;

/**
 * Build the task action for the packaged app's normal UI launch. The action
 * intentionally has no arguments: startMinimized and apply-on-boot remain
 * persisted app state, and the app owns those decisions after logon.
 * @param {string} execPath absolute path to the stable executable/wrapper
 */
export function buildStartupTaskCommand(execPath) {
  const trValue = `'${String(execPath)}'`;
  const psLiteral = `'${trValue.replace(/'/g, "''")}'`;
  return `schtasks /create /tn ${STARTUP_TASK_NAME} /sc onlogon /rl highest /tr ${psLiteral} /f`;
}

/**
 * Build the elevated setup/delete PowerShell command. The encoded inner
 * command avoids native PowerShell argument splitting for paths with spaces.
 * @param {string} command schtasks command
 * @param {{ powershellExe?: string }} [deps]
 */
export function buildStartupTaskLaunch(command, { powershellExe = POWERSHELL_EXE } = {}) {
  const encoded = Buffer.from(String(command), 'utf16le').toString('base64');
  const ps = String(powershellExe).replace(/'/g, "''");
  return `$p = Start-Process -FilePath '${ps}' -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' -Verb RunAs -Wait -PassThru -ErrorAction Stop; if ($null -eq $p) { exit 1 }; exit $p.ExitCode`;
}

function startupTaskActionMatches(task, execPath) {
  if (!task || typeof task.command !== 'string' || task.command.length === 0) return false;
  if (task.enabled === false) return false;
  const command = task.command.replace(/^"|"$/g, '');
  return command.toLowerCase() === String(execPath).toLowerCase()
    && typeof task.arguments === 'string'
    && task.arguments.trim() === '';
}

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
    const parentName = parent.split(/[\\/]/).pop() ?? '';
    // Only a portable wrapper is a stable logon target. The custom Installer
    // can be the temporary parent of the installed app on its first launch;
    // never persist that setup EXE as the installed app's startup target.
    if (/arc[-\s_]?power/i.test(parentName)
      && !/installer/i.test(parentName)
      && parent !== execPath) {
      return parent;
    }
  } catch {
    // parent query failed - fall back to process.execPath
  }
  return execPath;
}

/**
 * Remove registrations written by releases that used elevated scheduled
 * tasks or Electron's product-name Run value. Cleanup is deliberately
 * best-effort: the new startup registration must still be usable if an old task is
 * already absent or Windows refuses an old task deletion.
 * @param {typeof execFile} exec
 */
async function cleanupLegacyRegistrations(exec) {
  for (const taskName of LEGACY_TASK_NAMES) {
    try {
      await exec('schtasks', ['/delete', '/tn', taskName, '/f'], { windowsHide: true });
    } catch {
      // Missing or inaccessible legacy task - do not block the new setting.
    }
  }
  for (const valueName of LEGACY_RUN_VALUE_NAMES) {
    try {
      await exec('reg', ['delete', RUN_KEY, '/v', valueName, '/f'], { windowsHide: true });
    } catch {
      // Missing or inaccessible legacy value - do not block the new setting.
    }
  }
}

/**
 * Real adapter (reg.exe/schtasks via injectable execFile + spawn for tests).
 * Dev/legacy mode writes the Run value unelevated. Packaged Windows mode
 * creates/removes the elevated startup task through an explicit UAC action.
 * Both modes target the LOGON-STABLE executable (the portable wrapper when
 * packaged, else process.execPath).
 * @param {{
 *   execFile?: typeof execFile,
 *   spawnFn?: typeof nodeSpawn,
 *   execPath?: string,
 *   logonExecPath?: string,
 *   useElevatedTask?: boolean,
 *   taskName?: string,
 *   powershellExe?: string,
 *   cleanupLegacy?: boolean,
 * }} [deps]
 */
export function createStartup(deps = {}) {
  const exec = deps.execFile ?? execFile;
  const spawn = deps.spawnFn ?? nodeSpawn;
  const execPath = deps.logonExecPath ?? deps.execPath ?? process.execPath;
  const useElevatedTask = deps.useElevatedTask === true;
  const taskName = deps.taskName ?? STARTUP_TASK_NAME;
  const powershellExe = deps.powershellExe ?? POWERSHELL_EXE;
  const cleanupLegacy = deps.cleanupLegacy !== false;
  // A declined/failing UAC must not produce a prompt storm from concurrent
  // settings saves. A new app launch is the retry boundary.
  let elevatedSetupAttempted = false;
  let elevatedDeleteAttempted = false;

  const readTask = async () => {
    let exists = false;
    try {
      await exec('schtasks', ['/query', '/tn', taskName], { windowsHide: true, timeout: 10000 });
      exists = true;
    } catch {
      return { valueExists: false, value: null, taskExists: false };
    }
    try {
      const { stdout } = await exec('schtasks', ['/query', '/tn', taskName, '/xml'], {
        windowsHide: true,
        timeout: 10000,
        encoding: 'buffer',
      });
      const parsed = parseTaskXml(decodeTaskXml(stdout));
      if (!startupTaskActionMatches({ ...parsed, exists }, execPath)) {
        return { valueExists: false, value: null, taskExists: true };
      }
      return { valueExists: true, value: buildRunValue(execPath), registration: 'task', taskExists: true };
    } catch {
      return { valueExists: false, value: null, taskExists: true };
    }
  };

  const publicTaskState = (state) => {
    const { taskExists: _taskExists, ...publicState } = state;
    return publicState;
  };

  const runElevated = async (command) => new Promise((resolve) => {
    let child;
    try {
      child = spawn(powershellExe, ['-NoProfile', '-Command', buildStartupTaskLaunch(command, { powershellExe })], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      resolve(null);
      return;
    }
    child.on('exit', (code) => resolve(code));
    child.on('error', () => resolve(null));
  });

  const deleteRunValue = async () => {
    try {
      await exec('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { windowsHide: true });
    } catch (err) {
      if (err?.code !== REG_NOT_FOUND) throw new Error(`startup-set: legacy Run cleanup failed: ${err.message}`);
    }
  };

  return {
    // Main/IPC uses this to propagate an explicit task-setup failure to the
    // Profiles page. Legacy Run registration failures retain their previous
    // best-effort save behavior for compatibility.
    registrationMode: useElevatedTask ? 'task' : 'run',
    /**
     * The raw registration truth: whether our Run value/task exists and its
     * value. A query failure (absent value -> exit 1, or any other error)
     * degrades to valueExists:false - the read is never a boot blocker.
     * @returns {Promise<{ valueExists: boolean, value: string | null }>}
     */
    async get() {
      if (useElevatedTask) return publicTaskState(await readTask());
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
     * Enable = verify/create the packaged task (one explicit UAC) or write
     * the bare-quoted-exe Run value; disable removes the same registration.
     * @param {boolean} enabled
     * @returns {Promise<{ valueExists: boolean, value: string | null }>}
     */
    async set(enabled) {
      if (useElevatedTask) {
        const current = await readTask();
        if (enabled) {
          if (!current.valueExists) {
            if (elevatedSetupAttempted) {
              throw new Error('startup-set: administrator approval is required to create the Windows startup task (restart Arc Power to retry)');
            }
            elevatedSetupAttempted = true;
            const exitCode = await runElevated(buildStartupTaskCommand(execPath));
            if (exitCode !== 0) {
              throw new Error('startup-set: administrator approval is required to create the Windows startup task');
            }
            const afterSetup = await readTask();
            if (!afterSetup.valueExists) {
              throw new Error('startup-set: the Windows startup task was not created or points at a different executable');
            }
          }
          // A previous release may have left the HKCU Run value behind. It
          // must be removed after the task is verified, or Windows may start
          // two Arc Power processes at logon.
          await deleteRunValue();
          if (cleanupLegacy) await cleanupLegacyRegistrations(exec);
          return publicTaskState(await readTask());
        }
        // A stale or disabled task still has to be removed. Leaving it in
        // place would let an old executable launch at the next logon while
        // the UI claims Start with Windows is off.
        if (current.taskExists) {
          if (elevatedDeleteAttempted) {
            throw new Error('startup-set: administrator approval is required to remove the Windows startup task (restart Arc Power to retry)');
          }
          elevatedDeleteAttempted = true;
          const exitCode = await runElevated(`schtasks /delete /tn ${taskName} /f`);
          if (exitCode !== 0) {
            throw new Error('startup-set: administrator approval is required to remove the Windows startup task');
          }
        }
        await deleteRunValue();
        if (cleanupLegacy) await cleanupLegacyRegistrations(exec);
        const afterDelete = await readTask();
        if (afterDelete.valueExists) {
          throw new Error('startup-set: the Windows startup task could not be removed');
        }
        return publicTaskState(afterDelete);
      }
      if (enabled) {
        try {
          await exec('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', buildRunValue(execPath), '/f'], { windowsHide: true });
        } catch (err) {
          throw new Error(`startup-set: reg add failed: ${err.message}`);
        }
        if (cleanupLegacy) await cleanupLegacyRegistrations(exec);
        return this.get();
      }
      try {
        await exec('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { windowsHide: true });
      } catch (err) {
        if (err?.code !== REG_NOT_FOUND) throw new Error(`startup-set: reg delete failed: ${err.message}`);
      }
      if (cleanupLegacy) await cleanupLegacyRegistrations(exec);
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
