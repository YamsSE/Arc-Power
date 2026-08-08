// Arc Power — M4-E first-run elevated setup: the ArcPowerBootApply logon
// task (onlogon, /rl highest, FIXED action `<installed exe> --boot-apply`).
//
// Why a scheduled task at all: OC/fan writes persist ONLY from an elevated
// process. The installed app is asInvoker, so logon applies must run through
// an ELEVATED task. The task is created ONCE by the elevated first-run setup
// (one UAC at the first launch after install — the user is present) and is
// NEVER changed afterwards (unelevated schtasks /change on a /rl highest
// task is denied, /create is denied — the M4-E ground-truth probe). The
// task is SELF-GATING: its fixed action is `"<exe>" --boot-apply`, and the
// --boot-apply mode reads the persisted ocOnBoot setting itself and exits
// silently when off. No enable/disable/change calls EVER.
//
// The setup gate (UI window path of the INSTALLED build only — never
// headless/boot-apply/apply-profile/ui-verify, never the portable build):
//   - check(): unelevated reads — `schtasks /query /tn ArcPowerBootApply`
//     (exists?) + `/query /tn ... /xml` (the action Command+Arguments + the
//     <Enabled> state); GREEN = the task exists AND its action's exe path
//     equals the CURRENT process.execPath (case-insensitive, quotes
//     stripped, XML-unescaped — a reinstall to a different dir must never
//     leave a dead-action task silently; the stale-action hole S2c) AND the
//     task is not DISABLED (an admin-disabled task reads NOT green so the
//     elevated setup re-runs with /f and self-heals — a disabled task must
//     never cause silently-dead logon applies);
//   - setup(): the ELEVATED create/overwrite — `schtasks /create /tn
//     ArcPowerBootApply /sc onlogon /rl highest /tr '"<exe>" --boot-apply'
//     /f` run via PowerShell `Start-Process -Verb RunAs -Wait` (the SAME
//     elevation spawn pattern as the elevated-apply worker — one UAC, a
//     declined prompt is non-fatal and the gate re-triggers next launch).
//     Exactly ONE spawn per launch (a latch — never a UAC storm).
//
// Electron-free so the whole gate is unit-testable under plain node --test
// with injected execFile/spawn fakes (the tests never touch the real
// scheduler).

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn as nodeSpawn } from 'node:child_process';
import { POWERSHELL_EXE } from './elevated-apply.js';

const execFile = promisify(nodeExecFile);

export const BOOT_TASK_NAME = 'ArcPowerBootApply';
export const BOOT_TASK_ARGUMENT = '--boot-apply';
// The gate's unelevated schtasks reads + the elevated spawn timeout. A hung
// schtasks/powershell must never block boot for long.
export const SCHTASKS_TIMEOUT_MS = 10000;

/**
 * The exact `schtasks /create` command the ELEVATED setup runs.
 *
 * Quoting pin (plan M2 + r2-6 — LIVE-VALIDATED unelevated in run 1): the
 * /tr VALUE is the whole-quoted command `"C:\...\Arc Power.exe" --boot-apply`
 * (schtasks stores exactly that in the task XML — verified by read-back:
 * Command `"C:\...\Arc Power.exe"` + Arguments `--boot-apply`). The
 * PowerShell-level spelling is `''C:\...\Arc Power.exe' --boot-apply'` —
 * the single-quote-wrapped path AND ` --boot-apply` ride INSIDE one PS
 * string. PowerShell 5.1's native-argument marshaling wraps any
 * space-containing argument in double quotes WITHOUT escaping embedded
 * quotes, so the plan's original `'"C:\..." --boot-apply'` spelling reaches
 * schtasks as `""C:\..." --boot-apply"` and argv-splits at the first space
 * ("Invalid argument/option - 'Arc'"); and a bare separate `--boot-apply`
 * token after the /tr value is rejected as an option. The single-quote
 * spelling has NO embedded double quotes (clean marshaling), and the Task
 * Scheduler's /tr parser accepts the single-quoted first token and stores
 * the canonical whole-quoted Command — the exact value the gate read-back
 * compares (quote-stripped, case-insensitive).
 * `/f` overwrites (the stale-action re-set).
 * @param {string} execPath absolute path of the installed exe
 * @returns {string}
 */
export function buildSetupTaskCommand(execPath) {
  // What schtasks receives as /tr: the single-quote-wrapped path + the
  // --boot-apply flag in ONE argument (a separate --boot-apply token after
  // the /tr value is rejected as an unknown option).
  const trValue = `'${String(execPath)}' --boot-apply`;
  // The PowerShell-level spelling: the whole value as ONE PS single-quoted
  // string, every embedded quote doubled ('' inside '...').
  const psLiteral = `'${trValue.replace(/'/g, "''")}'`;
  return `schtasks /create /tn ${BOOT_TASK_NAME} /sc onlogon /rl highest /tr ${psLiteral} /f`;
}

/**
 * Encode a PowerShell command as base64 UTF-16LE (-EncodedCommand form).
 * The encoded payload has no spaces or quotes — it survives
 * Start-Process -ArgumentList verbatim.
 * @param {string} command
 * @returns {string}
 */
export function encodePowerShellCommand(command) {
  return Buffer.from(command, 'utf16le').toString('base64');
}

/**
 * The full unelevated->elevated launch script (the elevated-apply worker
 * spawn pattern): Start-Process -Verb RunAs -Wait -PassThru on an inner
 * PowerShell that runs the encoded schtasks command; the inner exit code
 * propagates. A declined UAC makes Start-Process fail (exit 1).
 * @param {string} execPath absolute path of the installed exe
 * @param {{ powershellExe?: string }} [deps]
 * @returns {string}
 */
export function buildSetupLaunch(execPath, { powershellExe = POWERSHELL_EXE } = {}) {
  const enc = encodePowerShellCommand(buildSetupTaskCommand(execPath));
  const ps = powershellExe.replace(/'/g, "''");
  return `$p = Start-Process -FilePath '${ps}' -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${enc}' -Verb RunAs -Wait -PassThru -ErrorAction Stop; if ($null -eq $p) { exit 1 }; exit $p.ExitCode`;
}

/**
 * Decode `schtasks /query /xml` stdout (a Buffer or string) into text.
 * schtasks writes UTF-16 (BOM-prefixed on some builds); without a BOM the
 * null-byte pattern distinguishes UTF-16 from UTF-8. Never throws.
 * @param {Buffer | string} raw
 * @returns {string}
 */
export function decodeTaskXml(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return buf.toString('utf16be', 2);
  let nullBytes = 0;
  for (let i = 0; i < Math.min(buf.length, 1024); i += 1) {
    if (buf[i] === 0) nullBytes += 1;
  }
  return nullBytes > 16 ? buf.toString('utf16le') : buf.toString('utf8');
}

/**
 * XML-unescape the standard + numeric entities.
 * @param {string} s
 * @returns {string}
 */
export function xmlUnescape(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)));
}

/**
 * Parse the task XML for the FIRST Exec action's Command + Arguments
 * (the plan's r2-5 read-back shape: separate <Command> + <Arguments>
 * elements, XML-escaped) plus the task's ENABLED state
 * (<Settings><Enabled>true</Enabled></Settings> — a task disabled by an
 * ADMIN (taskchd.msc, group policy, cleanup tools) must never read green,
 * or the gate would skip the in-app apply forever: the S1 silent-dead
 * failure mode the gate exists to prevent). Returns null when the Exec
 * shape is missing; `enabled` is null when the XML omits the element.
 * @param {string} xml
 * @returns {{ command: string, arguments: string, enabled: boolean | null } | null}
 */
export function parseTaskXml(xml) {
  const text = typeof xml === 'string' ? xml : String(xml ?? '');
  const execMatch = text.match(/<Exec>([\s\S]*?)<\/Exec>/);
  const block = execMatch ? execMatch[1] : text;
  const cmdMatch = block.match(/<Command>([\s\S]*?)<\/Command>/);
  const argMatch = block.match(/<Arguments>([\s\S]*?)<\/Arguments>/);
  const enabledMatch = text.match(/<Enabled>([\s\S]*?)<\/Enabled>/);
  if (!cmdMatch) return null;
  return {
    command: xmlUnescape(cmdMatch[1].trim()),
    arguments: argMatch ? xmlUnescape(argMatch[1].trim()) : '',
    enabled: enabledMatch ? enabledMatch[1].trim().toLowerCase() === 'true' : null,
  };
}

/**
 * The gate's GREEN decision (pure, testable): the task exists AND its
 * action's exe path equals the CURRENT installed exe (case-insensitive,
 * surrounding quotes stripped — schtasks stores the path unquoted) AND the
 * arguments carry the --boot-apply mode flag (a task pointing at the exe
 * without the flag would open a window at every logon — never green) AND
 * the task is not DISABLED (`enabled === false` — an admin-disabled task
 * reads NOT green so the elevated setup re-runs with /f and self-heals
 * instead of silently dead logon applies forever; a missing element is not
 * a disable).
 * @param {{ command: string | null, arguments: string | null, enabled?: boolean | null }} task
 * @param {string} execPath
 * @returns {boolean}
 */
export function taskActionMatches(task, execPath) {
  if (!task || typeof task.command !== 'string' || task.command.length === 0) return false;
  if (task.enabled === false) return false; // a DISABLED task is never green — the setup re-runs (/f self-heals)
  const cmd = task.command.replace(/^"|"$/g, '');
  if (cmd.toLowerCase() !== String(execPath).toLowerCase()) return false;
  return typeof task.arguments === 'string' && task.arguments.includes(BOOT_TASK_ARGUMENT);
}

/**
 * The setup-gate adapter. All deps injectable for tests — the tests never
 * touch the real scheduler.
 * @param {{
 *   execFile?: typeof execFile,
 *   spawnFn?: typeof nodeSpawn,
 *   powershellExe?: string,
 *   timeoutMs?: number,
 * }} [deps]
 */
export function createBootSetup(deps = {}) {
  const exec = deps.execFile ?? execFile;
  const spawn = deps.spawnFn ?? nodeSpawn;
  const powershellExe = deps.powershellExe ?? POWERSHELL_EXE;
  const timeoutMs = deps.timeoutMs ?? SCHTASKS_TIMEOUT_MS;
  // Exactly ONE elevated spawn per launch (a declined UAC must never
  // re-prompt in the same session).
  let spawned = false;

  return {
    /**
     * Unelevated gate read: does the task exist and what does its action
     * hold? Never throws — a query failure degrades to
     * { exists: false } / null parts (the gate then re-runs the setup).
     * @returns {Promise<{ exists: boolean, command: string | null, arguments: string | null, enabled: boolean | null }>}
     */
    async check() {
      let exists = false;
      try {
        await exec('schtasks', ['/query', '/tn', BOOT_TASK_NAME], { windowsHide: true, timeout: timeoutMs });
        exists = true;
      } catch {
        exists = false; // absent or unreadable — the gate is NOT green
      }
      if (!exists) return { exists: false, command: null, arguments: null, enabled: null };
      try {
        const { stdout } = await exec('schtasks', ['/query', '/tn', BOOT_TASK_NAME, '/xml'], { windowsHide: true, timeout: timeoutMs, encoding: 'buffer' });
        const parsed = parseTaskXml(decodeTaskXml(stdout));
        return { exists: true, command: parsed?.command ?? null, arguments: parsed?.arguments ?? null, enabled: parsed?.enabled ?? null };
      } catch {
        // The task exists but its action could not be read — not green
        // (the setup re-runs and /f overwrites).
        return { exists: true, command: null, arguments: null, enabled: null };
      }
    },

    /**
     * Run the ELEVATED create/overwrite once per launch. Resolves
     * { ok: true } on exit 0; a declined UAC or any other non-zero exit
     * resolves { ok: false, canceled: true } (never throws — the gate
     * simply re-triggers next launch). Subsequent calls in the same launch
     * resolve { alreadyStarted: true } without spawning.
     * @param {{ execPath: string }} deps
     * @returns {Promise<{ ok: boolean, canceled?: boolean, alreadyStarted?: boolean, exitCode?: number | null }>}
     */
    async setup({ execPath }) {
      if (spawned) return { ok: false, alreadyStarted: true };
      spawned = true;
      try {
        const exitCode = await new Promise((resolve) => {
          let child;
          try {
            child = spawn(powershellExe, ['-NoProfile', '-Command', buildSetupLaunch(execPath, { powershellExe })], { windowsHide: true, stdio: 'ignore' });
          } catch {
            resolve(null);
            return;
          }
          child.on('exit', (code) => resolve(code));
          child.on('error', () => resolve(null));
        });
        return exitCode === 0 ? { ok: true, exitCode } : { ok: false, canceled: true, exitCode };
      } finally {
        // The latch stays set — one spawn per launch by design.
      }
    },
  };
}
