// Arc Power — M3-B registry hacks APPLY side (electron-free, never writes
// anything non-elevated).
//
// The catalog (registry-catalog.js) carries the APPLY descriptor per entry:
// the exact reg.exe commands for the tweak's enabled state, its disabled
// state, and the revert (restore prior value — delete = system default).
// THIS module runs those commands ELEVATED and reports honestly what landed.
//
// Elevation (same pattern as elevated-apply.js / igs-service.js): the parent
// spawns PowerShell (injectable for tests) which Start-Process -Verb RunAs
// -Wait -PassThru an ELEVATED PowerShell running the reg commands — ONE UAC
// prompt per apply. The elevated script writes a per-step JSON result file
// (arcpower-reg-<uuid>.json in the temp dir) and exits non-zero on the
// first failed step:
//   - every step that ran is recorded (step index + ok) — the parent fills
//     the steps after the first failure as 'not-run';
//   - a UAC DECLINE leaves no result file (the elevated process never
//     started) -> the parent reports the honest "requires administrator
//     approval" result;
//   - a TIMEOUT kills the launcher, but the elevated child may still run
//     (late approval): the parent polls the result file for a grace window
//     and reports the REAL outcome if it lands, else the honest TIMED-OUT
//     wording — the two are never conflated;
//   - there is NEVER an auto-revert: a partial apply is reported step by
//     step and the user reverts via the Revert button (documented in the
//     result message).
//
// Safety: every write here goes through the elevated PowerShell — the
// non-elevated app never runs reg.exe add/delete. The default adapter for
// tests/--ui-verify/mock mode is the MOCK (never spawns, never elevates);
// it shares the mock registry state with the read adapter so the state
// refresh after an apply honestly reflects the "written" values.

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { REGISTRY_CATALOG, createMockRegistryState } from './registry-catalog.js';
import { buildElevatedLaunch } from './igs-service.js';

const execFile = promisify(nodeExecFile);

export const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
// The elevated script must finish within this window (reg.exe commands are
// fast; the bound exists so a hung PowerShell or a never-answered UAC prompt
// cannot stall the UI forever — 3 minutes is generous for a real approval).
export const REG_APPLY_TIMEOUT_MS = 180000;
// After the bound kills the launcher, the ELEVATED child may still be
// running — an approval granted just after the kill still executes the reg
// commands and writes the result file. This window is polled for the result
// file before declaring a timeout, so a late landing is reported honestly
// instead of being conflated with a decline.
export const REG_APPLY_GRACE_MS = 5000;
// The honest UAC-decline wording (same pattern as elevated-apply.js
// APPLY_CANCELED_ERROR) — DISTINCT from the timeout wording below.
export const REG_APPLY_CANCELED_ERROR = 'Applying this tweak requires administrator approval.';
// The honest TIMEOUT wording — a kill after the bound is NOT a decline: the
// approval may have been granted just too late, so the write may still land.
export const REG_APPLY_TIMEOUT_ERROR = `The elevated apply timed out after ${REG_APPLY_TIMEOUT_MS / 60000} minutes — no administrator approval completed in time (or the elevated process hung). If approval was granted after this message, the registry write may still have landed — refresh the state and use Revert if needed.`;
export const REG_ACTIONS = ['enable', 'disable', 'revert'];

// ---------------------------------------------------------------------------
// Pure builders (unit-testable, no process calls)
// ---------------------------------------------------------------------------

/**
 * The EXACT reg.exe argument list for one apply step (pinned in tests).
 * @param {import('./registry-catalog.js').RegistryApplyStep} step
 * @returns {string[]}
 */
export function buildRegArgs(step) {
  if (step.kind === 'add') {
    return ['add', step.path, '/v', step.value, '/t', step.type, '/d', step.data, '/f'];
  }
  if (step.kind === 'delete') {
    return ['delete', step.path, '/v', step.value, '/f'];
  }
  throw new Error(`registry-apply: unknown step kind '${step.kind}'`);
}

/**
 * Human label for one step (used in result messages + button tooltips).
 * @param {import('./registry-catalog.js').RegistryApplyStep} step
 * @returns {string}
 */
export function stepLabel(step) {
  return step.kind === 'add'
    ? `${step.value}=${step.data} written to ${step.path}`
    : `${step.value} deleted from ${step.path}`;
}

/**
 * PowerShell single-quoted-literal escaping (same rule as startup.js).
 * @param {string} s
 */
function psSingleQuote(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * Build the ELEVATED PowerShell script that runs one action's command list.
 * The script:
 *   1. runs each reg.exe command via the full path (PATH is not a trust
 *      boundary at the elevation boundary — same rule as igs-service.js);
 *   2. records every executed step as { step: <index>, ok: <bool> };
 *   3. stops at the FIRST failed step, writes the partial results to the
 *      result file and exits 1;
 *   4. on full success writes the results and exits 0.
 * The parent (createRegistryApply) spawns THIS script via
 * buildElevatedLaunch (Start-Process -Verb RunAs -Wait -PassThru) — a UAC
 * decline fails the spawn before any command runs, so no result file is
 * ever written and the parent reports the cancellation honestly.
 * @param {import('./registry-catalog.js').RegistryEntry} entry
 * @param {'enable'|'disable'|'revert'} action
 * @param {string} outPath absolute path of the JSON result file
 * @returns {string}
 */
export function buildRegApplyScript(entry, action, outPath) {
  const steps = entry.apply.actions[action];
  const lines = [
    `$reg = 'C:\\Windows\\System32\\reg.exe'`,
    `$out = '${psSingleQuote(outPath)}'`,
    '$res = @()',
  ];
  for (const [i, step] of steps.entries()) {
    const args = buildRegArgs(step).map((a) => `'${psSingleQuote(a)}'`).join(' ');
    lines.push(`& $reg ${args} | Out-Null`);
    lines.push(`$res += ,@{ step = ${i}; ok = ($LASTEXITCODE -eq 0) }`);
    lines.push(`if ($LASTEXITCODE -ne 0) { ConvertTo-Json -Compress -InputObject $res | Out-File -Encoding ascii $out; exit 1 }`);
  }
  // M3-C-A (BOM fix): the result file is written with `-Encoding ascii`, NOT
  // utf8 — PowerShell 5.1's `-Encoding utf8` emits a UTF-8 BOM (EF BB BF,
  // reproduced live) whose leading \uFEFF makes the parent's JSON.parse
  // reject the whole file, so every real tweak apply was reported as
  // failed/never-run while the reg writes had actually landed. The content
  // is pure ASCII (step indices + booleans), so ascii never BOMs.
  lines.push(`ConvertTo-Json -Compress -InputObject $res | Out-File -Encoding ascii $out`);
  lines.push('exit 0');
  return lines.join('; ');
}

/**
 * Parse the elevated script's result file into the executed steps. Returns
 * null on garbage — the caller then treats the apply as canceled/failed
 * honestly. Handles both array output and the single-step object shape.
 * @param {unknown} raw the file content (or JSON.parse output)
 * @returns {Array<{ step: number, ok: boolean }> | null}
 */
export function parseApplyOutcome(raw) {
  let parsed;
  try {
    // M3-C-A: defensively strip a leading UTF-8 BOM (\uFEFF) before parsing —
    // guards any future result-file writer that BOMs (PS 5.1 `-Encoding
    // utf8` was one; the current writer uses ascii, but the parse must not
    // depend on the writer staying perfect).
    const text = typeof raw === 'string' && raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    parsed = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.length === 0) return [];
  if (list.some((r) => typeof r !== 'object' || r === null || !Number.isInteger(r.step) || typeof r.ok !== 'boolean')) {
    return null;
  }
  return list.map((r) => ({ step: r.step, ok: r.ok }));
}

// ---------------------------------------------------------------------------
// Result assembly (per-step honesty — no silent partial state)
// ---------------------------------------------------------------------------

/**
 * Assemble the full per-step report from the executed steps + the expected
 * step list: executed steps are 'done'/'failed', steps the script never
 * reached are 'not-run'. The message is honest about partial applies and
 * states explicitly that nothing was rolled back automatically.
 */
function assembleResult(entry, action, steps, executed, canceled, cancelMessage = REG_APPLY_CANCELED_ERROR) {
  const perStep = steps.map((s, i) => {
    const rec = executed?.find((r) => r.step === i);
    const label = stepLabel(s);
    if (!rec) return { step: i, ok: false, status: 'not-run', label };
    return { step: i, ok: rec.ok === true, status: rec.ok ? 'done' : 'failed', label };
  });
  const done = perStep.filter((p) => p.status === 'done').length;
  const failed = perStep.filter((p) => p.status === 'failed').length;
  const notRun = perStep.filter((p) => p.status === 'not-run').length;
  let message;
  if (canceled) {
    message = cancelMessage;
  } else if (done === steps.length) {
    message = `${entry.name}: ${perStep.map((p) => p.label).join('; ')}`;
  } else if (failed > 0) {
    const failedAt = perStep.find((p) => p.status === 'failed');
    message = `Partial apply: ${done} of ${steps.length} step(s) landed, step ${failedAt.step + 1} failed, ${notRun} not run. Nothing was rolled back automatically — use Revert to restore the previous state.`;
  } else {
    message = `No steps landed — the apply failed before writing anything.`;
  }
  return { ok: done === steps.length, canceled, message, perStep };
}

// ---------------------------------------------------------------------------
// Real adapter (elevated PowerShell via injectable execFile)
// ---------------------------------------------------------------------------

async function readOutFile(filePath) {
  try {
    return parseApplyOutcome(await fs.promises.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Poll the result file for up to `timeoutMs` — used ONLY after the launcher
 * was killed by the bound, where the elevated child may legitimately still
 * be running (late approval). Returns the parsed outcome as soon as a
 * readable file appears, or null when the window elapses. The unlink must
 * NOT happen before this poll: the late write has to stay readable.
 */
async function waitForResultFile(filePath, timeoutMs, pollMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const executed = await readOutFile(filePath);
    if (executed) return executed;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function unlinkIfExists(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch { /* absent — nothing to do */ }
}

/**
 * Real adapter — injected into the IPC handlers in the product path.
 *
 * M3-C-B (elevation-aware): when the current process runs as administrator
 * (the packaged EXE always does — portable.requestExecutionLevel: admin),
 * reg.exe is executed DIRECTLY (no PowerShell, no RunAs, no result file):
 * each step runs through the injected execFile with per-step honest
 * reporting, stopping at the first failure exactly like the elevated script
 * does. The non-elevated fallback (dev mode) keeps the PowerShell RunAs
 * chain — one UAC prompt per action.
 * @param {import('./registry-catalog.js').RegistryEntry[]} [catalog]
 * @param {{
 *   execFile?: typeof execFile,
 *   tmpdir?: () => string,
 *   powershellExe?: string,
 *   log?: (s: string) => void,
 *   timeoutMs?: number,   // launcher bound (default REG_APPLY_TIMEOUT_MS)
 *   graceMs?: number,     // result-file poll window after a timeout (default REG_APPLY_GRACE_MS)
 *   isElevated?: () => boolean,  // M3-C-B: in-process elevation probe (default false = dev fallback)
 * }} [deps]
 */
export function createRegistryApply(catalog = REGISTRY_CATALOG, deps = {}) {
  const exec = deps.execFile ?? execFile;
  const tmpdir = deps.tmpdir ?? (() => os.tmpdir());
  const powershellExe = deps.powershellExe ?? POWERSHELL_EXE;
  const log = deps.log ?? (() => {});
  const timeoutMs = deps.timeoutMs ?? REG_APPLY_TIMEOUT_MS;
  const graceMs = deps.graceMs ?? REG_APPLY_GRACE_MS;
  const isElevated = deps.isElevated ?? (() => false);

  /**
   * M3-C-B direct path: the process is ALREADY elevated — run the reg
   * commands directly with the injected execFile. Per-step honest reporting
   * (same assembleResult envelope as the script path), stop at the first
   * failed step, NO result file, NO PowerShell, NO RunAs (the UAC-decline
   * wording is unreachable here by construction — the process holds the
   * privilege already).
   */
  async function applyDirect(entry, action, steps) {
    log(`[registry-apply] ${entry.id} ${action}: ${steps.length} step(s) via direct reg.exe (elevated process)`);
    const executed = [];
    for (const [i, step] of steps.entries()) {
      try {
        await exec('reg', buildRegArgs(step), { windowsHide: true, timeout: timeoutMs });
        executed.push({ step: i, ok: true });
      } catch (err) {
        log(`[registry-apply] ${entry.id} ${action}: step ${i + 1} failed (${err?.code ?? err?.message ?? 'reg.exe error'})`);
        executed.push({ step: i, ok: false });
        break;
      }
    }
    return assembleResult(entry, action, steps, executed, false);
  }

  return {
    /**
     * Apply one catalog action. When the current process is elevated the
     * action runs DIRECTLY (reg.exe via the injected execFile, per-step
     * honest reporting); otherwise the PowerShell RunAs chain elevates a
     * per-apply PowerShell (one UAC prompt). Never throws for expected
     * outcomes: UAC decline, partial failure and full success all return
     * the {ok, canceled, message, perStep} envelope. Throws only for
     * validation errors (unknown entry / read-only entry / bad action).
     * @param {string} entryId
     * @param {'enable'|'disable'|'revert'} action
     */
    async apply(entryId, action) {
      const entry = catalog.find((e) => e.id === entryId);
      if (!entry) throw new Error(`registry-apply: unknown entry '${entryId}'`);
      if (!REG_ACTIONS.includes(action)) {
        throw new Error(`registry-apply: action must be one of enable, disable, revert`);
      }
      if (!entry.apply?.applyable || !entry.apply.actions?.[action]) {
        throw new Error(`registry-apply: '${entryId}' is read-only (no ${action} commands)`);
      }
      const steps = entry.apply.actions[action];
      if (isElevated()) return applyDirect(entry, action, steps);
      const outPath = path.join(tmpdir(), `arcpower-reg-${randomUUID()}.json`);
      const script = buildRegApplyScript(entry, action, outPath);
      log(`[registry-apply] ${entryId} ${action}: ${steps.length} step(s) via elevated PowerShell`);
      let executed = null;
      let canceled = false;
      let timedOut = false;
      try {
        // Success path (exit 0) or a script-reported failure (non-zero) both
        // reject-or-resolve through execFile; the RESULT FILE is the truth —
        // the exit code only distinguishes "script ran" from "elevation
        // failed". A UAC decline leaves no result file at all.
        await exec(powershellExe, ['-NoProfile', '-Command', buildElevatedLaunch(script)], {
          windowsHide: true,
          timeout: timeoutMs,
        });
        executed = await readOutFile(outPath);
        if (!executed) {
          // Script "succeeded" but produced no readable result — a defensive
          // honest failure, never a silent success claim.
          return assembleResult(entry, action, steps, null, false);
        }
      } catch (err) {
        executed = await readOutFile(outPath);
        if (!executed) {
          // No result file: either the UAC prompt was DECLINED (the elevated
          // process never started) or the bound killed the launcher (a late
          // approval still runs the elevated reg commands). The two must NOT
          // be conflated: on a timeout, poll the result file for a grace
          // window — a late landing is reported as the real outcome, never
          // as a cancel.
          timedOut = err?.killed === true || err?.code === 'ETIMEDOUT';
          if (timedOut) {
            log(`[registry-apply] ${entryId} ${action}: bound exceeded — polling the result file for ${graceMs}ms`);
            executed = await waitForResultFile(outPath, graceMs);
            if (executed) log(`[registry-apply] ${entryId} ${action}: late result file appeared during the grace window — reporting the real outcome`);
          }
          if (!executed) {
            canceled = true;
            log(`[registry-apply] ${entryId} ${action}: ${timedOut ? 'timed out (no result within the grace window)' : 'elevation declined'}`);
          }
        }
      } finally {
        // The unlink happens only AFTER the grace poll — never before: the
        // late elevated write must stay readable for the whole window.
        await unlinkIfExists(outPath);
      }
      const cancelMessage = canceled && timedOut ? REG_APPLY_TIMEOUT_ERROR : undefined;
      return assembleResult(entry, action, steps, executed, canceled, cancelMessage);
    },
  };
}

// ---------------------------------------------------------------------------
// Mock adapter — used whenever the app runs in mock mode (tests, --ui-verify,
// RID_BACKEND=mock). Applies the descriptor's commands to the shared mock
// registry state (never spawns, never elevates); the read adapter then
// reflects the "written" values. Failure/cancel knobs exist so ui-verify can
// exercise the honest partial-failure + UAC-cancel UI paths.
// ---------------------------------------------------------------------------

/**
 * @param {import('./registry-catalog.js').RegistryEntry[]} [catalog]
 * @param {{
 *   state?: ReturnType<typeof createMockRegistryState>,
 *   failAt?: { entryId: string, action: 'enable'|'disable'|'revert', step: number },  // mock a mid-way reg failure
 *   canceledActions?: Set<string>,  // entryIds whose applies are UAC-canceled (mock only)
 *   delayMs?: number,               // simulated elevation latency (ui-verify in-flight knob)
 * }} [deps]
 */
export function createMockRegistryApply(catalog = REGISTRY_CATALOG, { state = createMockRegistryState(catalog), failAt = null, canceledActions = new Set(), delayMs = 0 } = {}) {
  return {
    async apply(entryId, action) {
      const entry = catalog.find((e) => e.id === entryId);
      if (!entry) throw new Error(`registry-apply: unknown entry '${entryId}'`);
      if (!REG_ACTIONS.includes(action)) {
        throw new Error(`registry-apply: action must be one of enable, disable, revert`);
      }
      if (!entry.apply?.applyable || !entry.apply.actions?.[action]) {
        throw new Error(`registry-apply: '${entryId}' is read-only (no ${action} commands)`);
      }
      const steps = entry.apply.actions[action];
      // Simulated elevation latency — lets ui-verify assert the buttons are
      // disabled while the apply promise is pending.
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (canceledActions.has(entryId)) {
        return { ok: false, canceled: true, message: REG_APPLY_CANCELED_ERROR, perStep: steps.map((s, i) => ({ step: i, ok: false, status: 'not-run', label: stepLabel(s) })) };
      }
      if (failAt && failAt.entryId === entryId && failAt.action === action) {
        // The knob's step is CLAMPED to the action's last step index so a
        // single-step action (hags/game-dvr) still exercises a step-1
        // failure instead of silently no-oping.
        const failStep = Math.min(Math.max(failAt.step, 0), steps.length - 1);
        // Simulate the elevated script failing mid-way: steps before the
        // failing one landed, the failing step + the rest did not run.
        for (const step of steps.slice(0, failStep)) state.applyStep(step);
        const executed = steps.slice(0, failStep + 1).map((_, i) => ({ step: i, ok: i < failStep }));
        return assembleResult(entry, action, steps, executed, false);
      }
      for (const step of steps) state.applyStep(step);
      const perStep = steps.map((s, i) => ({ step: i, ok: true, status: 'done', label: stepLabel(s) }));
      return { ok: true, canceled: false, message: `${entry.name}: ${perStep.map((p) => p.label).join('; ')}`, perStep };
    },
  };
}
