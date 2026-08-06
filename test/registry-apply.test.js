// M3-B — registry hacks APPLY side (registry-apply.js): the catalog apply
// descriptors (exact reg.exe command shapes), the elevated PowerShell script
// builder, the per-step result assembly (honest partial failure, no auto-
// revert), the real adapter orchestration (elevated spawn + UAC-cancel
// path + result-file parsing), and the mock adapter (shares the mock
// registry state with the read side). NO real registry access, NO real
// elevation — every spawn is a fake execFile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REGISTRY_CATALOG,
  createMockRegistryCatalog,
  createMockRegistryState,
} from '../src/main/registry-catalog.js';
import {
  POWERSHELL_EXE,
  REG_ACTIONS,
  REG_APPLY_CANCELED_ERROR,
  REG_APPLY_TIMEOUT_MS,
  buildRegArgs,
  stepLabel,
  buildRegApplyScript,
  parseApplyOutcome,
  createRegistryApply,
  createMockRegistryApply,
} from '../src/main/registry-apply.js';

function testDir(name) {
  return path.join(os.tmpdir(), `arcpower-regapply-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const entryOf = (id) => REGISTRY_CATALOG.find((e) => e.id === id);

/**
 * Extract the INNER elevated script out of the RunAs launch line
 * (buildElevatedLaunch embeds it single-quoted with doubled apostrophes).
 */
const innerScript = (launch) => launch.match(/-Command', '(.+)' -Verb RunAs/)[1].replace(/''/g, "'");
const outPathOf = (inner) => inner.match(/\$out = '(.+?)'/)[1];

// ---------------------------------------------------------------------------
// Apply descriptors (pinned command shapes)
// ---------------------------------------------------------------------------

test('descriptors: every applyable entry has the three action command lists, pinned exactly', () => {
  const expected = {
    mpo: {
      enable: [
        { kind: 'add', path: 'HKLM\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', value: 'MPOHack', type: 'REG_DWORD', data: '1' },
        { kind: 'add', path: 'HKCU\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', value: 'MPOHack', type: 'REG_DWORD', data: '1' },
      ],
      disable: [
        { kind: 'add', path: 'HKLM\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', value: 'MPOHack', type: 'REG_DWORD', data: '0' },
        { kind: 'add', path: 'HKCU\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', value: 'MPOHack', type: 'REG_DWORD', data: '0' },
      ],
      revert: [
        { kind: 'delete', path: 'HKLM\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', value: 'MPOHack' },
        { kind: 'delete', path: 'HKCU\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', value: 'MPOHack' },
      ],
    },
    hags: {
      enable: [{ kind: 'add', path: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', value: 'HwSchMode', type: 'REG_DWORD', data: '2' }],
      disable: [{ kind: 'add', path: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', value: 'HwSchMode', type: 'REG_DWORD', data: '1' }],
      revert: [{ kind: 'delete', path: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', value: 'HwSchMode' }],
    },
    'game-dvr': {
      enable: [{ kind: 'add', path: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\GameDVR', value: 'AllowGameDVR', type: 'REG_DWORD', data: '0' }],
      disable: [{ kind: 'add', path: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\GameDVR', value: 'AllowGameDVR', type: 'REG_DWORD', data: '1' }],
      revert: [{ kind: 'delete', path: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\GameDVR', value: 'AllowGameDVR' }],
    },
  };
  for (const [id, actions] of Object.entries(expected)) {
    const entry = entryOf(id);
    assert.equal(entry.apply.applyable, true, `${id}: applyable`);
    assert.deepEqual(entry.apply.actions, actions, `${id}: pinned command lists`);
    assert.ok(entry.apply.revertNote.length > 20, `${id}: revertNote`);
  }
});

test('descriptors: fullscreen-optimizations is applyable:false with no actions', () => {
  const entry = entryOf('fullscreen-optimizations');
  assert.equal(entry.apply.applyable, false);
  assert.equal(entry.apply.actions, undefined);
});

test('descriptors: mpo documents its plain-language purpose (M3-C-H)', () => {
  // M3-C-H: the long canonical-location/hive-caveat prose is GONE — the
  // description is 1-2 plain-language lines about fixing stutter/black
  // screens, off by default in Windows.
  const desc = entryOf('mpo').description;
  assert.match(desc, /stutter|black-screen/);
  assert.match(desc, /off by default in Windows/);
  assert.ok(!desc.includes('HKCU applies use the elevated session'), 'the hive caveat prose is removed');
  assert.ok(desc.length <= 240, '1-2 plain-language lines');
});

test('descriptors: apply targets agree with the read vocabulary (enable writes on, disable writes off)', () => {
  // MPO: reads on='1' off='0' (both hives); HAGS: on='2' off='1'; DVR: on='0' off='1'.
  const mpo = entryOf('mpo');
  assert.ok(mpo.apply.actions.enable.every((s) => s.data === mpo.reads[0].on));
  assert.ok(mpo.apply.actions.disable.every((s) => s.data === mpo.reads[0].off));
  assert.ok(mpo.apply.actions.enable.every((s) => mpo.reads.some((r) => r.path === s.path && r.value === s.value)));
  const hags = entryOf('hags');
  assert.equal(hags.apply.actions.enable[0].data, hags.reads[0].on);
  assert.equal(hags.apply.actions.disable[0].data, hags.reads[0].off);
  const dvr = entryOf('game-dvr');
  assert.equal(dvr.apply.actions.enable[0].data, dvr.reads[0].on);
  assert.equal(dvr.apply.actions.disable[0].data, dvr.reads[0].off);
  // Reverts always DELETE the read value (restore prior state = system default).
  for (const id of ['mpo', 'hags', 'game-dvr']) {
    const e = entryOf(id);
    assert.ok(e.apply.actions.revert.every((s) => s.kind === 'delete'), `${id}: revert deletes`);
    assert.ok(e.apply.actions.revert.every((s) => e.reads.some((r) => r.path === s.path && r.value === s.value)), `${id}: revert targets a read value`);
  }
});

test('descriptors: every apply step is well-formed (kind/path/value, add has type+data)', () => {
  for (const entry of REGISTRY_CATALOG.filter((e) => e.apply?.applyable)) {
    for (const [action, steps] of Object.entries(entry.apply.actions)) {
      assert.ok(steps.length >= 1, `${entry.id}/${action}: at least one step`);
      for (const s of steps) {
        assert.ok(s.kind === 'add' || s.kind === 'delete', `${entry.id}/${action}: step kind`);
        assert.ok(s.path.startsWith('HKLM\\') || s.path.startsWith('HKCU\\'), `${entry.id}/${action}: hive path`);
        assert.ok(typeof s.value === 'string' && s.value.length > 0, `${entry.id}/${action}: value name`);
        if (s.kind === 'add') {
          assert.equal(s.type, 'REG_DWORD', `${entry.id}/${action}: add type`);
          assert.ok(/^[0-9]+$/.test(s.data), `${entry.id}/${action}: decimal dword data`);
        } else {
          assert.equal(s.data, undefined, `${entry.id}/${action}: delete carries no data`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// reg.exe argument builder (pure)
// ---------------------------------------------------------------------------

test('buildRegArgs: add pins /v /t /d /f; delete pins /v /f', () => {
  assert.deepEqual(
    buildRegArgs({ kind: 'add', path: 'HKLM\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', value: 'MPOHack', type: 'REG_DWORD', data: '1' }),
    ['add', 'HKLM\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', '/v', 'MPOHack', '/t', 'REG_DWORD', '/d', '1', '/f'],
  );
  assert.deepEqual(
    buildRegArgs({ kind: 'delete', path: 'HKCU\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', value: 'MPOHack' }),
    ['delete', 'HKCU\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', '/v', 'MPOHack', '/f'],
  );
  assert.throws(() => buildRegArgs({ kind: 'nuke' }), /unknown step kind/);
});

test('stepLabel: human labels for add/delete (honest tooltips + messages)', () => {
  assert.equal(
    stepLabel({ kind: 'add', path: 'HKLM\\A', value: 'V', type: 'REG_DWORD', data: '1' }),
    'V=1 written to HKLM\\A',
  );
  assert.equal(stepLabel({ kind: 'delete', path: 'HKLM\\A', value: 'V' }), 'V deleted from HKLM\\A');
});

// ---------------------------------------------------------------------------
// Elevated script builder (pure)
// ---------------------------------------------------------------------------

test('buildRegApplyScript: contains the exact elevated reg commands, per-step recorders, result write, exit codes', () => {
  const script = buildRegApplyScript(entryOf('hags'), 'disable', 'C:\\temp\\out.json');
  // The reg command itself runs via the FULL path (PATH is not a trust
  // boundary at the elevation boundary), every argument single-quoted.
  assert.match(script, /^\$reg = 'C:\\Windows\\System32\\reg\.exe'/);
  assert.match(script, /& \$reg 'add' 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers' '\/v' 'HwSchMode' '\/t' 'REG_DWORD' '\/d' '1' '\/f' \| Out-Null/);
  assert.match(script, /\$res \+= ,@\{ step = 0; ok = \(\$LASTEXITCODE -eq 0\) \}/);
  // M3-C-A (BOM fix): the result file is written with `-Encoding ascii` —
  // PS 5.1's `-Encoding utf8` writes a BOM that broke JSON.parse in the
  // parent (live-verified). ascii never BOMs; pinned here.
  assert.match(script, /if \(\$LASTEXITCODE -ne 0\) \{ ConvertTo-Json -Compress -InputObject \$res \| Out-File -Encoding ascii \$out; exit 1 \}/);
  assert.match(script, /ConvertTo-Json -Compress -InputObject \$res \| Out-File -Encoding ascii \$out/);
  assert.ok(!script.includes('-Encoding utf8'), 'the script must never use -Encoding utf8 (BOM)');
  assert.match(script, /exit 0$/);
  // The out path rides along for the per-step JSON.
  assert.match(script, /\$out = 'C:\\temp\\out\.json'/);
});

test('buildRegApplyScript: mpo enable writes BOTH hives and stops on the first failure', () => {
  const script = buildRegApplyScript(entryOf('mpo'), 'enable', 'C:\\out.json');
  assert.match(script, /'add' 'HKLM\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences' '\/v' 'MPOHack' '\/t' 'REG_DWORD' '\/d' '1' '\/f'/);
  assert.match(script, /'add' 'HKCU\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences' '\/v' 'MPOHack' '\/t' 'REG_DWORD' '\/d' '1' '\/f'/);
  // Two step recorders; a step-1 failure exits before step 2 (never run).
  assert.equal((script.match(/step = \d/g) ?? []).length, 2, 'one recorder per step');
  const failCount = (script.match(/exit 1/g) ?? []).length;
  assert.equal(failCount, 2, 'one early-exit guard per step');
});

test('buildRegApplyScript: escapes apostrophes in the result path (PowerShell single-quote rule)', () => {
  const script = buildRegApplyScript(entryOf('hags'), 'enable', "C:\\temp\\user's\\out.json");
  assert.match(script, /\$out = 'C:\\temp\\user''s\\out\.json'/);
});

test('parseApplyOutcome: array / single-object / garbage handling', () => {
  assert.deepEqual(parseApplyOutcome('[{"step":0,"ok":true},{"step":1,"ok":false}]'), [
    { step: 0, ok: true },
    { step: 1, ok: false },
  ]);
  assert.deepEqual(parseApplyOutcome('{"step":0,"ok":true}'), [{ step: 0, ok: true }]);
  assert.deepEqual(parseApplyOutcome(''), null);
  assert.deepEqual(parseApplyOutcome('[{"step":"x","ok":true}]'), null);
  assert.deepEqual(parseApplyOutcome('[{"step":0,"ok":1}]'), null);
});

test('M3-C-A: parseApplyOutcome strips a leading BOM (\\uFEFF) before parsing', () => {
  // PS 5.1's `-Encoding utf8` writes EF BB BF — the live bug that made every
  // real tweak apply report as failed/never-run. The parse must survive it.
  assert.deepEqual(parseApplyOutcome('\uFEFF[{"step":0,"ok":true},{"step":1,"ok":false}]'), [
    { step: 0, ok: true },
    { step: 1, ok: false },
  ]);
  assert.deepEqual(parseApplyOutcome('\uFEFF{"step":0,"ok":false}'), [{ step: 0, ok: false }]);
  // The strip is defensive — BOM-prefixed garbage still fails honestly.
  assert.deepEqual(parseApplyOutcome('\uFEFF'), null);
});

// ---------------------------------------------------------------------------
// Real adapter orchestration (fake execFile — never spawns)
// ---------------------------------------------------------------------------

test('M3-C-B: an ELEVATED process applies DIRECTLY via reg.exe (no PowerShell, no RunAs, no result file)', async () => {
  const dir = testDir('direct');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const calls = [];
    let spawnedPowershell = false;
    const exec = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === POWERSHELL_EXE) spawnedPowershell = true;
      return { stdout: '', stderr: '' };
    };
    const runner = createRegistryApply(REGISTRY_CATALOG, { execFile: exec, isElevated: () => true });
    const out = await runner.apply('mpo', 'enable');
    assert.equal(spawnedPowershell, false, 'an elevated process must never spawn PowerShell');
    // Both steps ran DIRECTLY as reg.exe invocations with the exact args.
    assert.deepEqual(calls.map((c) => c.cmd), ['reg', 'reg']);
    assert.deepEqual(calls[0].args, ['add', 'HKLM\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', '/v', 'MPOHack', '/t', 'REG_DWORD', '/d', '1', '/f']);
    assert.deepEqual(calls[1].args, ['add', 'HKCU\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', '/v', 'MPOHack', '/t', 'REG_DWORD', '/d', '1', '/f']);
    assert.equal(out.ok, true);
    assert.equal(out.canceled, false);
    assert.deepEqual(out.perStep.map((p) => [p.step, p.status]), [[0, 'done'], [1, 'done']]);
    assert.match(out.message, /MPOHack=1 written to HKLM/);
    // No result file was ever involved.
    assert.equal(fs.readdirSync(dir).filter((f) => f.includes('arcpower-reg-')).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M3-C-B: direct reg path stops at the FIRST failed step with honest per-step reporting', async () => {
  const dir = testDir('direct-fail');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const calls = [];
    const exec = async (cmd, args) => {
      calls.push(args);
      if (calls.length === 1) {
        const err = new Error('reg.exe exited 1');
        err.code = 1;
        throw err;
      }
      return { stdout: '', stderr: '' };
    };
    const runner = createRegistryApply(REGISTRY_CATALOG, { execFile: exec, isElevated: () => true });
    const out = await runner.apply('mpo', 'disable');
    assert.equal(out.ok, false);
    assert.equal(out.canceled, false);
    // Step 1 failed; step 2 was never run (the direct loop broke).
    assert.equal(calls.length, 1, 'the loop must stop at the first failed step');
    assert.deepEqual(out.perStep.map((p) => [p.step, p.status]), [[0, 'failed'], [1, 'not-run']]);
    assert.match(out.message, /Partial apply: 0 of 2 step\(s\) landed, step 1 failed/);
    assert.match(out.message, /Nothing was rolled back automatically/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M3-C-B: non-elevated process keeps the PowerShell RunAs chain (dev fallback)', async () => {
  const dir = testDir('nonelev');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const calls = [];
    const exec = async (cmd, args) => {
      calls.push(cmd);
      // Emulate the elevated script writing the result file.
      const outPath = outPathOf(innerScript(args[2]));
      fs.writeFileSync(outPath, '[{"step":0,"ok":true}]');
      return { stdout: '', stderr: '' };
    };
    const runner = createRegistryApply(REGISTRY_CATALOG, { execFile: exec, tmpdir: () => dir, isElevated: () => false });
    const out = await runner.apply('hags', 'disable');
    assert.deepEqual(calls, [POWERSHELL_EXE], 'non-elevated: exactly one PowerShell launch');
    assert.equal(out.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply: spawns the elevated PowerShell launch and returns the per-step success', async () => {
  const dir = testDir('ok');
  fs.mkdirSync(dir, { recursive: true });
  try {
    let launch = null;
    let spawnCmd = null;
    const exec = async (cmd, args, opts) => {
      spawnCmd = cmd;
      launch = args[2];
      // Emulate the elevated script: extract the out path from the script,
      // write the all-ok per-step JSON, exit 0.
      const outPath = outPathOf(innerScript(launch));
      fs.writeFileSync(outPath, '[{"step":0,"ok":true},{"step":1,"ok":true}]');
      return { stdout: '', stderr: '' };
    };
    const runner = createRegistryApply(REGISTRY_CATALOG, { execFile: exec, tmpdir: () => dir });
    const out = await runner.apply('mpo', 'disable');
    assert.equal(spawnCmd, POWERSHELL_EXE, 'spawned the absolute powershell.exe');
    // The launch is the RunAs launcher (same pattern as elevated-apply.js)
    // wrapping the inner reg script.
    assert.match(launch, /Start-Process -FilePath 'C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe'/);
    assert.match(launch, /-Verb RunAs -Wait -PassThru -ErrorAction Stop/);
    assert.match(launch, /exit \$p\.ExitCode/);
    assert.match(innerScript(launch), /& \$reg 'add' 'HKLM\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences' '\/v' 'MPOHack' '\/t' 'REG_DWORD' '\/d' '0' '\/f' \| Out-Null/);
    assert.equal(out.ok, true);
    assert.equal(out.canceled, false);
    assert.deepEqual(out.perStep.map((p) => [p.step, p.status]), [[0, 'done'], [1, 'done']]);
    assert.match(out.message, /MPOHack=0 written to HKLM\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences/);
    // The result file is cleaned up after the read.
    assert.equal(fs.readdirSync(dir).filter((f) => f.includes('arcpower-reg-')).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply: UAC decline (error 1223, no result file) -> honest requires-administrator result, nothing ran', async () => {
  const dir = testDir('cancel');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const exec = async () => {
      const err = new Error('The operation was canceled by the user.');
      err.code = 1223;
      throw err;
    };
    const runner = createRegistryApply(REGISTRY_CATALOG, { execFile: exec, tmpdir: () => dir });
    const out = await runner.apply('hags', 'enable');
    assert.equal(out.ok, false);
    assert.equal(out.canceled, true);
    assert.equal(out.message, REG_APPLY_CANCELED_ERROR);
    assert.ok(!out.message.includes('timed out'), 'a decline must not reuse the timeout wording');
    assert.ok(out.perStep.every((p) => p.status === 'not-run'), 'nothing ran on a UAC decline');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply: a result file landing AFTER the launcher kill (grace window) is reported as the real outcome — never a false cancel', async () => {
  const dir = testDir('grace');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const exec = async (cmd, args) => {
      // The launcher is killed by the bound, but the ELEVATED child outlives
      // it (a late approval still ran the reg commands): the result file
      // lands a moment after the parent's exec rejected.
      const outPath = outPathOf(innerScript(args[2]));
      setTimeout(() => {
        try { fs.writeFileSync(outPath, '[{"step":0,"ok":true},{"step":1,"ok":true}]'); } catch { /* already cleaned up */ }
      }, 100);
      const err = new Error('Command failed: ETIMEDOUT');
      err.killed = true;
      err.code = 'ETIMEDOUT';
      throw err;
    };
    const runner = createRegistryApply(REGISTRY_CATALOG, { execFile: exec, tmpdir: () => dir, graceMs: 3000 });
    const out = await runner.apply('mpo', 'enable');
    assert.equal(out.canceled, false, 'a late result must NOT be reported as a cancel');
    assert.equal(out.ok, true);
    assert.deepEqual(out.perStep.map((p) => [p.step, p.status]), [[0, 'done'], [1, 'done']]);
    assert.match(out.message, /MPOHack=1 written to HKLM/);
    assert.equal(fs.readdirSync(dir).filter((f) => f.includes('arcpower-reg-')).length, 0, 'the result file is still cleaned up after the grace read');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply: a true timeout (no result file ever) is reported with the TIMED-OUT wording — distinct from a decline', async () => {
  const dir = testDir('timeout');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const exec = async () => {
      const err = new Error('Command failed: ETIMEDOUT');
      err.killed = true;
      err.code = 'ETIMEDOUT';
      throw err;
    };
    const runner = createRegistryApply(REGISTRY_CATALOG, { execFile: exec, tmpdir: () => dir, graceMs: 300 });
    const out = await runner.apply('hags', 'enable');
    assert.equal(out.ok, false);
    assert.equal(out.canceled, true);
    assert.match(out.message, new RegExp(`timed out after ${REG_APPLY_TIMEOUT_MS / 60000} minutes`));
    assert.ok(!out.message.includes('requires administrator approval'), 'a timeout must not reuse the decline wording');
    assert.ok(out.perStep.every((p) => p.status === 'not-run'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply: partial failure — step 1 of 2 lands, step 2 fails, rest not run; NO auto-revert', async () => {
  const dir = testDir('partial');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const exec = async (cmd, args) => {
      // The elevated script stopped at step 1: step 0 landed, step 1 failed.
      const outPath = outPathOf(innerScript(args[2]));
      fs.writeFileSync(outPath, '[{"step":0,"ok":true},{"step":1,"ok":false}]');
      const err = new Error('reg.exe exited 1');
      err.code = 1;
      throw err;
    };
    const runner = createRegistryApply(REGISTRY_CATALOG, { execFile: exec, tmpdir: () => dir });
    const out = await runner.apply('mpo', 'disable');
    assert.equal(out.ok, false);
    assert.equal(out.canceled, false);
    assert.deepEqual(out.perStep.map((p) => [p.step, p.status, p.ok]), [[0, 'done', true], [1, 'failed', false]]);
    assert.match(out.message, /Partial apply: 1 of 2 step\(s\) landed, step 2 failed/);
    assert.match(out.message, /Nothing was rolled back automatically — use Revert to restore the previous state\./);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply: 3-step partial — step 2 fails, step 3 is reported not-run', async () => {
  const dir = testDir('partial3');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const exec = async (cmd, args) => {
      const outPath = outPathOf(innerScript(args[2]));
      fs.writeFileSync(outPath, '[{"step":0,"ok":true},{"step":1,"ok":false}]');
      const err = new Error('reg.exe exited 1');
      err.code = 1;
      throw err;
    };
    // Synthetic catalog: hags enable has THREE steps so the not-run path is
    // visible (the real catalog actions have 1-2 steps).
    const synthetic = REGISTRY_CATALOG.map((e) => e.id === 'hags'
      ? { ...e, apply: { ...e.apply, actions: { ...e.apply.actions, enable: [...e.apply.actions.enable, ...e.apply.actions.enable, ...e.apply.actions.enable] } } }
      : e);
    const runner = createRegistryApply(synthetic, { execFile: exec, tmpdir: () => dir });
    const out = await runner.apply('hags', 'enable');
    assert.deepEqual(out.perStep.map((p) => [p.step, p.status]), [[0, 'done'], [1, 'failed'], [2, 'not-run']]);
    assert.equal(out.ok, false);
    assert.match(out.message, /step 2 failed, 1 not run/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply: script exit 0 but unreadable result file -> honest failure (never a false success)', async () => {
  const dir = testDir('noout');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const exec = async () => ({ stdout: '', stderr: '' }); // no file written
    const runner = createRegistryApply(REGISTRY_CATALOG, { execFile: exec, tmpdir: () => dir });
    const out = await runner.apply('hags', 'enable');
    assert.equal(out.ok, false);
    assert.equal(out.canceled, false);
    assert.match(out.message, /No steps landed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply: validation — unknown entry / read-only entry / bad action throw', async () => {
  const runner = createRegistryApply(REGISTRY_CATALOG, { execFile: async () => ({}) });
  await assert.rejects(() => runner.apply('nope', 'enable'), /unknown entry 'nope'/);
  await assert.rejects(() => runner.apply('fullscreen-optimizations', 'enable'), /read-only/);
  await assert.rejects(() => runner.apply('hags', 'explode'), /action must be one of/);
});

// ---------------------------------------------------------------------------
// Mock adapter (shared mock registry state — the read side reflects applies)
// ---------------------------------------------------------------------------

async function readStates(catalog, state) {
  return createMockRegistryCatalog(catalog, { state }).get();
}

test('mock: mpo enable/disable/revert round trip flips the shared read state honestly', async () => {
  const catalog = REGISTRY_CATALOG;
  const state = createMockRegistryState(catalog);
  const apply = createMockRegistryApply(catalog, { state });

  const stateOf = async () => (await readStates(catalog, state)).states.find((s) => s.id === 'mpo');

  assert.equal((await stateOf()).state, 'disabled'); // fixture default
  const enable = await apply.apply('mpo', 'enable');
  assert.equal(enable.ok, true);
  assert.deepEqual(enable.perStep.map((p) => p.status), ['done', 'done']);
  assert.equal((await stateOf()).state, 'enabled');
  assert.equal((await stateOf()).reads.every((r) => r.value === '0x1'), true);

  const disable = await apply.apply('mpo', 'disable');
  assert.equal(disable.ok, true);
  assert.equal((await stateOf()).state, 'disabled');
  assert.equal((await stateOf()).reads.every((r) => r.value === '0x0'), true);

  const revert = await apply.apply('mpo', 'revert');
  assert.equal(revert.ok, true);
  assert.equal((await stateOf()).state, 'default');
  assert.equal((await stateOf()).reads.every((r) => r.found === false), true);
});

test('mock: hags + game-dvr round trips (2 on / 1 off / absent; 0 on / 1 off / absent)', async () => {
  const catalog = REGISTRY_CATALOG;
  const state = createMockRegistryState(catalog);
  const apply = createMockRegistryApply(catalog, { state });
  const stateOf = async (id) => (await readStates(catalog, state)).states.find((s) => s.id === id);

  assert.equal((await stateOf('hags')).state, 'enabled'); // 0x2 fixture
  await apply.apply('hags', 'disable');
  assert.equal((await stateOf('hags')).state, 'disabled');
  await apply.apply('hags', 'revert');
  assert.equal((await stateOf('hags')).state, 'default');
  await apply.apply('hags', 'enable');
  assert.equal((await stateOf('hags')).state, 'enabled');

  assert.equal((await stateOf('game-dvr')).state, 'default');
  await apply.apply('game-dvr', 'enable');
  assert.equal((await stateOf('game-dvr')).state, 'enabled');
  await apply.apply('game-dvr', 'disable');
  assert.equal((await stateOf('game-dvr')).state, 'disabled');
  await apply.apply('game-dvr', 'revert');
  assert.equal((await stateOf('game-dvr')).state, 'default');
});

test('mock: fullscreen-optimizations is read-only — apply throws, state untouched', async () => {
  const catalog = REGISTRY_CATALOG;
  const state = createMockRegistryState(catalog);
  const apply = createMockRegistryApply(catalog, { state });
  await assert.rejects(() => apply.apply('fullscreen-optimizations', 'revert'), /read-only/);
  const out = await readStates(catalog, state);
  assert.equal(out.states.find((s) => s.id === 'fullscreen-optimizations').state, 'enabled');
});

test('mock: failAt simulates a mid-way failure — landed steps only reach the read state, not-run reported', async () => {
  const catalog = REGISTRY_CATALOG;
  const state = createMockRegistryState(catalog);
  const apply = createMockRegistryApply(catalog, { state, failAt: { entryId: 'mpo', action: 'disable', step: 1 } });
  const out = await apply.apply('mpo', 'disable');
  assert.equal(out.ok, false);
  assert.deepEqual(out.perStep.map((p) => [p.step, p.status]), [[0, 'done'], [1, 'failed']]);
  assert.match(out.message, /Nothing was rolled back automatically/);
  // Only step 0 (HKLM add) landed — HKCU still holds the fixture 0x0.
  const mpo = (await readStates(catalog, state)).states.find((s) => s.id === 'mpo');
  assert.equal(mpo.reads[0].value, '0x0', 'HKLM add landed');
  assert.equal(mpo.reads[1].value, '0x0', 'HKCU untouched');
});

test('mock: failAt clamps to the action\'s last step so single-step actions still exercise a step-1 failure', async () => {
  const catalog = REGISTRY_CATALOG;
  const state = createMockRegistryState(catalog);
  // main.js always hands the knob's step=1 down — for a one-step action the
  // clamp must map it to step 0 (the first AND only step fails) instead of
  // silently no-oping into a full success.
  const apply = createMockRegistryApply(catalog, { state, failAt: { entryId: 'hags', action: 'enable', step: 1 } });
  const out = await apply.apply('hags', 'enable');
  assert.equal(out.ok, false);
  assert.deepEqual(out.perStep.map((p) => [p.step, p.status]), [[0, 'failed']]);
  assert.match(out.message, /0 of 1 step\(s\) landed, step 1 failed/);
  const hags = (await readStates(catalog, state)).states.find((s) => s.id === 'hags');
  assert.equal(hags.state, 'enabled', 'nothing landed — the fixture HwSchMode=0x2 is untouched');
});

test('mock: delayMs knob applies with the simulated latency (ui-verify in-flight knob)', async () => {
  const catalog = REGISTRY_CATALOG;
  const state = createMockRegistryState(catalog);
  const apply = createMockRegistryApply(catalog, { state, delayMs: 20 });
  const t0 = Date.now();
  const out = await apply.apply('mpo', 'enable');
  assert.equal(out.ok, true);
  assert.ok(Date.now() - t0 >= 10, 'the apply actually waited for the simulated latency');
  assert.equal((await readStates(catalog, state)).states.find((s) => s.id === 'mpo').state, 'enabled');
});

test('mock: canceledActions simulates the UAC decline (nothing ran, nothing changed)', async () => {
  const catalog = REGISTRY_CATALOG;
  const state = createMockRegistryState(catalog);
  const apply = createMockRegistryApply(catalog, { state, canceledActions: new Set(['mpo']) });
  const out = await apply.apply('mpo', 'enable');
  assert.equal(out.ok, false);
  assert.equal(out.canceled, true);
  assert.equal(out.message, REG_APPLY_CANCELED_ERROR);
  assert.ok(out.perStep.every((p) => p.status === 'not-run'));
  const mpo = (await readStates(catalog, state)).states.find((s) => s.id === 'mpo');
  assert.equal(mpo.state, 'disabled', 'fixture state untouched by the canceled apply');
});
