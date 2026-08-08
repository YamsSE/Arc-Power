// M4-E — the ArcPowerBootApply setup gate tests (setup-boot.js): the pinned
// /tr quoting form, the elevated launch script, the /xml read-back parsing
// (UTF-16 + entities), the GREEN decision, and the check/setup adapter with
// INJECTED fakes — these tests never touch the real scheduler.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOT_TASK_NAME,
  buildSetupTaskCommand,
  encodePowerShellCommand,
  buildSetupLaunch,
  decodeTaskXml,
  parseTaskXml,
  taskActionMatches,
  createBootSetup,
  xmlUnescape,
} from '../src/main/setup-boot.js';
import { POWERSHELL_EXE } from '../src/main/elevated-apply.js';

// ---------------------------------------------------------------------------
// The pinned /tr quoting form (plan M2 + r2-6): the /tr VALUE is the
// whole-quoted command `"<exe>" --boot-apply`; the PowerShell-level form is
// the outer-single-quoted `'"<exe>" --boot-apply'`.
// ---------------------------------------------------------------------------

test('buildSetupTaskCommand: the pinned /tr form — whole-quoted command, single-quote spelling (r2-6 LIVE-validated end-to-end)', () => {
  const cmd = buildSetupTaskCommand('C:\\Program Files\\Arc Power\\Arc Power.exe');
  assert.equal(
    cmd,
    `schtasks /create /tn ArcPowerBootApply /sc onlogon /rl highest /tr '''C:\\Program Files\\Arc Power\\Arc Power.exe'' --boot-apply' /f`,
  );
  assert.ok(cmd.includes('/f'), 'the /f overwrite is always present (stale-action re-set)');
  assert.ok(cmd.includes('/rl highest'), 'the task runs elevated');
  // The /tr VALUE the Task Scheduler stores is the whole-quoted command
  // `"C:\...\Arc Power.exe" --boot-apply` — the single-quote spelling is
  // what survives PowerShell 5.1 native marshaling (run-1 live-validated:
  // the double-quoted spelling argv-splits into "Invalid argument/option -
  // 'Arc'"; the separate `--boot-apply` token is rejected as an option).
  const stored = taskActionMatches({ command: `"C:\\Program Files\\Arc Power\\Arc Power.exe"`, arguments: '--boot-apply' }, 'C:\\Program Files\\Arc Power\\Arc Power.exe');
  assert.equal(stored, true, 'the stored (whole-quoted) Command is what the gate read-back compares');
});

test('buildSetupTaskCommand: an embedded single quote in the path is PowerShell-doubled (never breaks the script)', () => {
  const cmd = buildSetupTaskCommand("C:\\Odd'Dir\\Arc Power.exe");
  assert.ok(cmd.includes(`/tr '''C:\\Odd''Dir\\Arc Power.exe'' --boot-apply'`), `quoted form: ${cmd}`);
});

test('buildSetupLaunch: the elevated-apply worker spawn pattern — RunAs -Wait -PassThru + exit-code propagation', () => {
  const launch = buildSetupLaunch('C:\\Program Files\\Arc Power\\Arc Power.exe');
  assert.match(launch, /Start-Process -FilePath 'C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe'/);
  assert.match(launch, /-Verb RunAs -Wait -PassThru -ErrorAction Stop/);
  assert.match(launch, /if \(\$null -eq \$p\) \{ exit 1 \}; exit \$p\.ExitCode/);
  // The inner command rides as -EncodedCommand (no spaces/quotes to mangle).
  const enc = launch.match(/-EncodedCommand','([A-Za-z0-9+/=]+)'/);
  assert.ok(enc, 'the encoded command is present in the argument list');
  assert.equal(
    Buffer.from(enc[1], 'base64').toString('utf16le'),
    buildSetupTaskCommand('C:\\Program Files\\Arc Power\\Arc Power.exe'),
    'the encoded command decodes to the exact pinned schtasks command',
  );
  // Round-trip: encodePowerShellCommand is the inverse of the decode above.
  assert.equal(encodePowerShellCommand('x'), Buffer.from('x', 'utf16le').toString('base64'));
});

// ---------------------------------------------------------------------------
// The /xml read-back (r2-5): UTF-16 decode + entity unescape + Command /
// Arguments split + the GREEN comparison.
// ---------------------------------------------------------------------------

const TASK_XML_UTF16 = (command, args, enabled = true) => {
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Settings>
    <Enabled>${enabled}</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${command}</Command>
      <Arguments>${args}</Arguments>
    </Exec>
  </Actions>
</Task>`;
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
};

test('decodeTaskXml: a BOM-prefixed UTF-16 buffer (what schtasks writes) decodes to text', () => {
  const xml = '<Task><Command>C:\\Program Files\\Arc Power\\Arc Power.exe</Command></Task>';
  const decoded = decodeTaskXml(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
  assert.ok(decoded.includes('<Command>C:\\Program Files\\Arc Power\\Arc Power.exe</Command>'), decoded);
  assert.ok(!decoded.includes('\u0000'), 'no null-byte garbage');
});

test('decodeTaskXml: a BOM-less UTF-16 buffer (null-byte pattern) and plain UTF-8 both decode', () => {
  const xml = '<Task><Command>C:\\Arc.exe</Command></Task>';
  assert.ok(decodeTaskXml(Buffer.from(xml, 'utf16le')).includes('<Command>C:\\Arc.exe</Command>'));
  assert.ok(decodeTaskXml(Buffer.from(xml, 'utf8')).includes('<Command>C:\\Arc.exe</Command>'));
  assert.ok(decodeTaskXml(xml).includes('<Command>C:\\Arc.exe</Command>'), 'a plain string passes through');
});

test('parseTaskXml: extracts the Exec action Command + Arguments (entities unescaped)', () => {
  const parsed = parseTaskXml(decodeTaskXml(TASK_XML_UTF16('C:\\Program Files\\Arc Power &amp; More\\Arc Power.exe', '--boot-apply')));
  assert.deepEqual(parsed, {
    command: 'C:\\Program Files\\Arc Power & More\\Arc Power.exe',
    arguments: '--boot-apply',
    enabled: true,
  });
  assert.equal(xmlUnescape('&amp;&lt;&gt;&quot;&apos;&#x41;'), '&<>"\'A');
});

test('parseTaskXml: extracts the <Enabled> state — true AND false (an admin-disabled task must read through)', () => {
  assert.equal(parseTaskXml(decodeTaskXml(TASK_XML_UTF16('C:\\Arc.exe', '--boot-apply', false))).enabled, false);
  assert.equal(parseTaskXml(decodeTaskXml(TASK_XML_UTF16('C:\\Arc.exe', '--boot-apply', true))).enabled, true);
  // A fixture WITHOUT the element -> null (missing is not a disable).
  const noSettings = decodeTaskXml(TASK_XML_UTF16('C:\\Arc.exe', '--boot-apply')).replace(/<Settings>[\s\S]*?<\/Settings>/, '');
  assert.equal(parseTaskXml(noSettings).enabled, null);
});

test('parseTaskXml: missing Exec/Command shape -> null (never a fake green)', () => {
  assert.equal(parseTaskXml('<Task><Actions/></Task>'), null);
  assert.equal(parseTaskXml(''), null);
});

test('taskActionMatches: GREEN only for an exact case-insensitive exe path + the --boot-apply argument', () => {
  const execPath = 'C:\\Program Files\\Arc Power\\Arc Power.exe';
  assert.equal(taskActionMatches({ command: execPath, arguments: '--boot-apply' }, execPath), true);
  // case-insensitive (schtasks may store a different casing)
  assert.equal(taskActionMatches({ command: 'c:\\program files\\ARC POWER\\arc power.EXE', arguments: '--boot-apply' }, execPath), true);
  // surrounding quotes stripped (the stored Command is unquoted, but never trust it)
  assert.equal(taskActionMatches({ command: `"${execPath}"`, arguments: '--boot-apply' }, execPath), true);
  // a DIFFERENT exe (reinstall to another dir — the stale-action hole) is NOT green
  assert.equal(taskActionMatches({ command: 'C:\\Old Install\\Arc Power.exe', arguments: '--boot-apply' }, execPath), false);
  // missing / foreign arguments are NOT green (a bare exe task would open a window at logon)
  assert.equal(taskActionMatches({ command: execPath, arguments: '' }, execPath), false);
  assert.equal(taskActionMatches({ command: execPath, arguments: '--other' }, execPath), false);
  // unknown parts are NOT green
  assert.equal(taskActionMatches({ command: null, arguments: null }, execPath), false);
  assert.equal(taskActionMatches(null, execPath), false);
  // an admin-DISABLED task is NOT green even with the exact exe + argument
  // (the setup re-runs with /f and self-heals — never silently-dead applies)
  assert.equal(taskActionMatches({ command: execPath, arguments: '--boot-apply', enabled: false }, execPath), false);
  // an explicit enabled:true and a MISSING enabled element are both green-eligible
  assert.equal(taskActionMatches({ command: execPath, arguments: '--boot-apply', enabled: true }, execPath), true);
  assert.equal(taskActionMatches({ command: execPath, arguments: '--boot-apply', enabled: null }, execPath), true);
});

// ---------------------------------------------------------------------------
// The gate adapter (injected execFile/spawn — never the real scheduler).
// ---------------------------------------------------------------------------

function fakeExecWith(script) {
  return async (cmd, args) => {
    const line = `${cmd} ${args.join(' ')}`;
    if (!script.hasOwnProperty(line)) {
      const err = new Error(`unexpected exec: ${line}`);
      err.code = 'UNEXPECTED';
      throw err;
    }
    return script[line];
  };
}

test('check: task missing (schtasks /query errors) -> { exists: false }, no XML query, gate not green', async () => {
  const seen = [];
  const execFile = async (cmd, args) => {
    seen.push(`${cmd} ${args.join(' ')}`);
    const err = new Error('ERROR: The system cannot find the file specified.');
    err.code = 1;
    throw err;
  };
  const gate = createBootSetup({ execFile });
  const task = await gate.check();
  assert.deepEqual(task, { exists: false, command: null, arguments: null, enabled: null });
  assert.deepEqual(seen, ['schtasks /query /tn ArcPowerBootApply']);
  assert.equal(taskActionMatches(task, 'C:\\Program Files\\Arc Power\\Arc Power.exe'), false);
});

test('check: task exists -> the /xml action is read back (UTF-16) and the gate goes green for the CURRENT exe', async () => {
  const execPath = 'C:\\Program Files\\Arc Power\\Arc Power.exe';
  const xml = TASK_XML_UTF16('C:\\Program Files\\Arc Power\\Arc Power.exe', '--boot-apply');
  const gate = createBootSetup({
    execFile: fakeExecWith({
      'schtasks /query /tn ArcPowerBootApply': { stdout: 'INFO: The task exists.' },
      'schtasks /query /tn ArcPowerBootApply /xml': { stdout: xml },
    }),
  });
  const task = await gate.check();
  assert.equal(task.exists, true);
  assert.equal(task.command, execPath);
  assert.equal(task.arguments, '--boot-apply');
  assert.equal(taskActionMatches(task, execPath), true);
});

test('check: task exists but the action points at a DIFFERENT exe -> gate NOT green (stale-action hole)', async () => {
  const gate = createBootSetup({
    execFile: fakeExecWith({
      'schtasks /query /tn ArcPowerBootApply': { stdout: 'INFO: The task exists.' },
      'schtasks /query /tn ArcPowerBootApply /xml': { stdout: TASK_XML_UTF16('C:\\Old Install\\Arc Power.exe', '--boot-apply') },
    }),
  });
  const task = await gate.check();
  assert.equal(task.exists, true);
  assert.equal(taskActionMatches(task, 'C:\\Program Files\\Arc Power\\Arc Power.exe'), false);
});

test('check: an XML read failure degrades to not-green parts (the setup re-runs with /f)', async () => {
  const gate = createBootSetup({
    execFile: fakeExecWith({
      'schtasks /query /tn ArcPowerBootApply': { stdout: 'INFO: The task exists.' },
    }),
  });
  const task = await gate.check();
  assert.deepEqual(task, { exists: true, command: null, arguments: null, enabled: null });
  assert.equal(taskActionMatches(task, 'C:\\Program Files\\Arc Power\\Arc Power.exe'), false);
});

test('check: an admin-DISABLED task (<Enabled>false</Enabled>) reads enabled:false -> gate NOT green (the setup re-runs with /f and self-heals)', async () => {
  const execPath = 'C:\\Program Files\\Arc Power\\Arc Power.exe';
  const gate = createBootSetup({
    execFile: fakeExecWith({
      'schtasks /query /tn ArcPowerBootApply': { stdout: 'INFO: The task exists.' },
      'schtasks /query /tn ArcPowerBootApply /xml': { stdout: TASK_XML_UTF16(execPath, '--boot-apply', false) },
    }),
  });
  const task = await gate.check();
  assert.equal(task.exists, true);
  assert.equal(task.command, execPath);
  assert.equal(task.arguments, '--boot-apply');
  assert.equal(task.enabled, false, 'the /xml read-back must surface the disabled state');
  // The exact action + argument but a DISABLED task — NEVER green: a green
  // gate here would skip the in-app apply at every launch (the S1
  // silent-dead failure mode) and the setup would never re-run.
  assert.equal(taskActionMatches(task, execPath), false);
});

test('check: a task with an explicit <Enabled>true</Enabled> reads enabled:true and stays green-eligible', async () => {
  const execPath = 'C:\\Program Files\\Arc Power\\Arc Power.exe';
  const gate = createBootSetup({
    execFile: fakeExecWith({
      'schtasks /query /tn ArcPowerBootApply': { stdout: 'INFO: The task exists.' },
      'schtasks /query /tn ArcPowerBootApply /xml': { stdout: TASK_XML_UTF16(execPath, '--boot-apply', true) },
    }),
  });
  const task = await gate.check();
  assert.equal(task.enabled, true);
  assert.equal(taskActionMatches(task, execPath), true);
});

test('setup: spawns the elevated launch ONCE per launch and reports the exit code truth', async () => {
  const spawns = [];
  const gate = createBootSetup({
    spawnFn: (cmd, args) => {
      spawns.push({ cmd, args });
      const handlers = {};
      const child = { on: (ev, cb) => { handlers[ev] = cb; return child; }, kill: () => {} };
      child.exit = (code) => handlers.exit?.(code);
      setImmediate(() => child.exit(0));
      return child;
    },
  });
  const first = await gate.setup({ execPath: 'C:\\Program Files\\Arc Power\\Arc Power.exe' });
  assert.deepEqual(first, { ok: true, exitCode: 0 });
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].cmd, POWERSHELL_EXE);
  assert.deepEqual(spawns[0].args.slice(0, 2), ['-NoProfile', '-Command']);
  assert.ok(spawns[0].args[2].includes('-Verb RunAs -Wait -PassThru'));
  // The latch: a second call in the same launch never spawns again.
  const second = await gate.setup({ execPath: 'C:\\Program Files\\Arc Power\\Arc Power.exe' });
  assert.deepEqual(second, { ok: false, alreadyStarted: true });
  assert.equal(spawns.length, 1, 'exactly ONE elevated spawn per launch');
});

test('setup: a declined UAC (non-zero exit) resolves { canceled: true } — the gate re-triggers next launch', async () => {
  const gate = createBootSetup({
    spawnFn: () => {
      const handlers = {};
      const child = { on: (ev, cb) => { handlers[ev] = cb; return child; }, kill: () => {} };
      child.exit = (code) => handlers.exit?.(code);
      setImmediate(() => child.exit(1));
      return child;
    },
  });
  const out = await gate.setup({ execPath: 'C:\\Program Files\\Arc Power\\Arc Power.exe' });
  assert.equal(out.ok, false);
  assert.equal(out.canceled, true);
});

test('setup: a spawn failure (child error) also degrades to the non-fatal canceled outcome', async () => {
  const gate = createBootSetup({
    spawnFn: () => {
      const handlers = {};
      const child = { on: (ev, cb) => { handlers[ev] = cb; return child; }, kill: () => {} };
      child.error = () => handlers.error?.();
      setImmediate(() => child.error());
      return child;
    },
  });
  const out = await gate.setup({ execPath: 'C:\\Program Files\\Arc Power\\Arc Power.exe' });
  assert.equal(out.ok, false);
  assert.equal(out.canceled, true);
});
