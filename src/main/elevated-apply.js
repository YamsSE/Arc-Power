// Arc Power - M2C-C elevation-aware apply orchestration (electron-free).
//
// The elevation gate (docs/igcl-integration.md §8c): OC writes persist ONLY
// from an elevated client. A non-elevated app therefore delegates every OC
// action to an elevated SELF-WORKER (`--apply-worker <req> <out>`) spawned
// via PowerShell `Start-Process -Verb RunAs -Wait` (one UAC prompt per
// action). The worker is our own executable: same code, hidden (no window,
// no tray), never re-elevates, exits after writing the result file.
//
// Contract:
//   request file  (JSON): { requestId, op: 'apply'|'waiver-accept'|'reset',
//                           deviceId, deviceKey?, physicalTarget?, settings?, profileName?,
//                           waiverAccepted? }
//   token file    (JSON): { requestId, expiresAt } - written by the parent
//                           BEFORE the request file; the parent-owned
//                           timeout marker the startup sweep + the worker's
//                           stale-token guard key off.
//   result file   (JSON): { requestId, op, ok, perControl?, state?, error? }
//   - all three files are keyed by the SAME requestId
//     (arcpower-req-<id>.json / arcpower-tok-<id>.json /
//     arcpower-out-<id>.json);
//   - the result file is written ONLY by the worker; a missing file after
//     the spawn returned = UAC canceled/denied (or the worker crashed
//     before writing) -> APPLY_CANCELED_ERROR;
//   - the elevated app never spawns: needsWorker() === false -> in-process
//     apply via the injected executor.
//
// Orphan policy (worker timeout): killing the PowerShell wrapper does NOT
// kill the elevated electron worker - it may still perform the apply and
// write the result file after the parent reported APPLY_CANCELED_ERROR.
// Mitigations:
//   - the parent removes its request + token files on timeout - a worker
//     that has not yet read the request then fails honestly ("request
//     unreadable") instead of silently applying;
//   - the result file is NEVER unlinked while the worker may still write it
//     (removed only after a successful read or a visible worker exit) - no
//     torn-write race, no stray file from a late write;
//   - the parent-owned token expires `tokenTtlMs` after spawning; the next
//     app start sweeps expired request/result/token triples, and a worker
//     that starts into a directory holding an EXPIRED token refuses to run
//     (the parent already gave up);
//   - a worker already mid-apply when the parent gives up completes its
//     write and its result file records the truth - a bounded, documented
//     orphan, cleaned by the next startup sweep.
//
// Electron-free so the worker contract is unit-testable under node --test
// with injected spawn/file deps.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { isElevated as detectElevated } from './elevation.js';
import { withCapabilityFlags } from './apply-routing.js';

export const APPLY_CANCELED_ERROR = 'Apply requires administrator approval.';
export const WORKER_TIMEOUT_MS = 120000;
// The parent-owned token's lifetime: the worker's whole wait window plus
// margin for the slowest legit write/verification to land.
export const TOKEN_TTL_MS = WORKER_TIMEOUT_MS * 2;
export const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/**
 * Build the PowerShell launch line that starts OUR executable elevated and
 * waits for it: Start-Process -Verb RunAs -Wait -PassThru, propagating the
 * worker's exit code. UAC decline makes Start-Process fail (exit 1) - the
 * parent then finds no result file and reports the honest cancellation.
 *
 * Dev mode (`electron .`): process.execPath is electron.exe and the app
 * path must ride along. Quoting trap (found live at CP3a): passing a
 * space-containing app path through Start-Process -ArgumentList hangs
 * electron's own CLI parsing - the app path is therefore passed as '.'
 * with -WorkingDirectory pointing at the app dir (no spaces in the arg
 * list); the packaged portable EXE needs no app path at all.
 * @param {string} execPath absolute path of our executable
 * @param {string | null} appPath app directory (dev-mode electron only;
 *   null for the packaged EXE)
 * @param {string} reqPath absolute request-file path
 * @param {string} outPath absolute result-file path
 * @returns {string}
 */
export function buildWorkerLaunch(execPath, appPath, reqPath, outPath) {
  const quoteArg = (a) => `'"${a.replace(/"/g, '\\"')}"'`;
  const innerArgs = ['--apply-worker', reqPath, outPath].map(quoteArg).join(', ');
  const appArg = appPath ? `'.', ` : '';
  const workingDir = appPath ? ` -WorkingDirectory '${appPath.replace(/'/g, "''")}'` : '';
  return `$p = Start-Process -FilePath '${execPath.replace(/'/g, "''")}'${workingDir} -ArgumentList ${appArg}${innerArgs} -Verb RunAs -Wait -PassThru -ErrorAction Stop; if ($null -eq $p) { exit 1 }; exit $p.ExitCode`;
}

/**
 * Write a JSON file (atomic-ish: temp + rename not needed for the worker
 * contract - the parent reads only AFTER the spawn returned; a torn write
 * would fail the parse and surface as an honest error).
 */
export async function writeJsonFile(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(value), 'utf8');
}

async function unlinkIfExists(filePath) {
  try {
    await fs.promises.unlink(filePath);
    return 1;
  } catch {
    return 0;
  }
}

/**
 * Fresh-startup sweep of stale worker files (a crashed/killed parent's
 * leftovers). Safety rule: a request/result file is removed ONLY when its
 * parent-owned token is expired (the parent gave up) - a live request's
 * fresh token is never touched. Request/result files WITHOUT a token are
 * old-format garbage and are removed once older than the token TTL. Expired
 * tokens are removed even when their request/result files are gone.
 *
 * M17i: the sweep covers BOTH file families with the same triple semantics -
 * the apply-worker family (arcpower-req/out/tok-<id>.json) and the
 * sysman-helper family (arcpower-sm-req/out/tok-<id>.json). The packaged
 * app never runs runWorker (its applies are in-process), so the helper
 * proxy's pre-spawn sweep is the sm- family's only invocation site. The
 * families are processed separately so a shared id can never collide
 * across them (an arcpower-req-X live triple must never be judged by an
 * arcpower-sm-tok-X sibling).
 * @param {string} dir the shared temp dir
 * @param {{ now?: number, tokenTtlMs?: number }} [deps]
 * @returns {Promise<number>} number of files removed
 */
export async function sweepStaleWorkerFiles(dir, { now = Date.now(), tokenTtlMs = TOKEN_TTL_MS } = {}) {
  let files;
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return 0; // no dir yet - nothing to sweep
  }
  let removed = 0;
  // The two file families (see the M17i note above). Each family's triple
  // logic is identical - only the filename prefixes differ.
  const families = [
    { req: 'arcpower-req-', out: 'arcpower-out-', tok: 'arcpower-tok-' },
    { req: 'arcpower-sm-req-', out: 'arcpower-sm-out-', tok: 'arcpower-sm-tok-' },
  ];
  const allTokNames = new Set();
  for (const family of families) {
    const reqIds = new Set();
    const outIds = new Set();
    const reqRe = new RegExp(`^${family.req}(.+)\\.json$`);
    const outRe = new RegExp(`^${family.out}(.+)\\.json$`);
    for (const f of files) {
      const rm = reqRe.exec(f);
      if (rm) { reqIds.add(rm[1]); continue; }
      const om = outRe.exec(f);
      if (om) outIds.add(om[1]);
    }
    const ids = new Set([...reqIds, ...outIds]);
    for (const id of ids) {
      const tokPath = path.join(dir, `${family.tok}${id}.json`);
      allTokNames.add(`${family.tok}${id}`);
      // 'fresh' (live request) | 'stale' (parent gave up) | 'unreadable'
      // (torn/partial token write) | 'absent' (old-format leftover).
      let tokState = 'absent';
      try {
        const tok = JSON.parse(await fs.promises.readFile(tokPath, 'utf8'));
        tokState = typeof tok.expiresAt === 'number' && tok.expiresAt < now ? 'stale' : 'fresh';
      } catch {
        // The parent always COMPLETES its token write before writing the
        // request file (runWorker order), so an existing-but-unreadable token
        // is a torn-write leftover - the parent's apply already failed and no
        // worker was spawned for it. Treat it as expired-and-removable (N2)
        // instead of letting it linger forever.
        try {
          await fs.promises.access(tokPath);
          tokState = 'unreadable';
        } catch {
          tokState = 'absent';
        }
      }
      if (tokState === 'stale' || tokState === 'unreadable') {
        removed += await unlinkIfExists(tokPath);
        removed += await unlinkIfExists(path.join(dir, `${family.req}${id}.json`));
        removed += await unlinkIfExists(path.join(dir, `${family.out}${id}.json`));
        continue;
      }
      if (tokState === 'absent') {
        // No token: only remove once older than the TTL (a live request
        // always has a fresh token).
        for (const f of [`${family.req}${id}.json`, `${family.out}${id}.json`]) {
          try {
            const st = await fs.promises.stat(path.join(dir, f));
            if (now - st.mtimeMs > tokenTtlMs) removed += await unlinkIfExists(path.join(dir, f));
          } catch { /* absent - nothing to remove */ }
        }
      }
    }
  }
  // Expired tokens with no matching request/result file.
  for (const f of files) {
    const m = f.match(/^arcpower(-sm)?-tok-(.+)\.json$/);
    if (!m) continue;
    const tokName = m[1] ? `arcpower-sm-tok-${m[2]}.json` : `arcpower-tok-${m[2]}.json`;
    if (allTokNames.has(tokName)) continue;
    let remove = false;
    try {
      const tok = JSON.parse(await fs.promises.readFile(path.join(dir, f), 'utf8'));
      remove = typeof tok.expiresAt === 'number' && tok.expiresAt < now;
    } catch {
      // Unreadable/partial token with no siblings: nothing will ever parse
      // it and no request depends on it - remove it (N2).
      remove = true;
    }
    if (remove) removed += await unlinkIfExists(path.join(dir, f));
  }
  return removed;
}

/**
 * Create the apply runner.
 * @param {{
 *   isElevated?: () => boolean,
 *   execPath?: string,
 *   appPath?: string | null,      // dev-mode electron app path (null = packaged EXE)
 *   powershellExe?: string,
 *   tmpdir?: () => string,
 *   spawnFn?: (cmd: string, args: string[], opts: object) => { on: (ev: string, cb: (code: number | null) => void) => void },
 *   killOnTimeout?: boolean,
 *   workerTimeoutMs?: number,
 *   tokenTtlMs?: number,         // parent-owned token lifetime (default TOKEN_TTL_MS)
  *   inProcess?: {
  *     apply: (req: { deviceId: number, settings: object, profileApply?: boolean }) => Promise<{ result: object, state: object | null }>,
  *     waiverAccept: (deviceId: number) => Promise<void>,
  *     reset: (deviceId: number) => Promise<{ state: object | null }>,
  *     graphicsApply: (req: { deviceId: number, settings: object }) => Promise<{ ok: boolean, perControl: object, graphicsState: object | null }>,
  *   },
 *   log?: (s: string) => void,
 * }} deps
 */
export function createApplyRunner({
  isElevated = detectElevated,
  execPath = process.execPath,
  appPath = null,
  powershellExe = POWERSHELL_EXE,
  tmpdir = () => os.tmpdir(),
  spawnFn = null,
  workerTimeoutMs = WORKER_TIMEOUT_MS,
  tokenTtlMs = TOKEN_TTL_MS,
  inProcess = null,
  log = () => {},
} = {}) {
  const elevated = isElevated();
  log(`[apply-runner] process is ${elevated ? 'ELEVATED' : 'not elevated'} - ${elevated ? 'in-process apply' : 'elevated self-worker'}`);
  const spawn = spawnFn ?? nodeSpawn;

  async function runWorker(req) {
    const dir = tmpdir();
    // M2: request/result/token files are keyed by the SAME requestId - a
    // paired cleanup story + the sweep's identity.
    const rid = req.requestId ?? randomUUID();
    const reqPath = path.join(dir, `arcpower-req-${rid}.json`);
    const outPath = path.join(dir, `arcpower-out-${rid}.json`);
    const tokPath = path.join(dir, `arcpower-tok-${rid}.json`);
    // M2: fresh-startup sweep of a crashed parent's leftovers. Only files
    // whose parent-owned token expired are removed - a live request's fresh
    // token keeps its files untouched.
    await sweepStaleWorkerFiles(dir, { tokenTtlMs });
    // M2: the parent-owned token (written BEFORE the request file) marks
    // this request as live; its expiry bounds how long the worker is
    // allowed to start after the parent gave up.
    await writeJsonFile(tokPath, { requestId: rid, expiresAt: Date.now() + tokenTtlMs });
    await writeJsonFile(reqPath, req);
    let result = null;
    let killed = false;
    let spawnFailed = false;
    let workerExited = false;
    try {
      const child = await spawn(powershellExe, ['-NoProfile', '-Command', buildWorkerLaunch(execPath, appPath, reqPath, outPath)], {
        windowsHide: true,
        stdio: 'ignore',
      });
      await new Promise((resolve) => {
        let settled = false;
        const done = (code) => {
          if (settled) return;
          settled = true;
          log(`[apply-runner] elevated worker ${workerExited && !killed ? 'exited' : 'detached'} (code ${code})`);
          resolve();
        };
        const timer = setTimeout(() => {
          log('[apply-runner] elevated worker TIMED OUT - killing');
          killed = true;
          try { child.kill(); } catch { /* best effort */ }
          done(null);
        }, workerTimeoutMs);
        child.on('exit', (code) => { workerExited = true; clearTimeout(timer); done(code); });
        child.on('error', () => { spawnFailed = true; clearTimeout(timer); done(null); });
      });
      try {
        const raw = await fs.promises.readFile(outPath, 'utf8');
        result = JSON.parse(raw);
      } catch {
        result = null;
      }
      if (!result || typeof result !== 'object') {
        // No result file: UAC canceled/denied or the worker never ran.
        return { worker: true, canceled: true, result: null };
      }
      return { worker: true, canceled: false, result };
    } finally {
      // M2 cleanup rules (see the orphan policy above):
      //  - req + token are always removed: a late worker that has not yet
      //    read the request then fails honestly instead of silently applying;
      //  - the result file is NEVER unlinked while the worker may still
      //    write it - removed only after a successful read (result set), a
      //    visible worker exit (killed === false - the wrapper's -Wait only
      //    returns after the worker exited), or a failed spawn (the worker
      //    never started). A killed wrapper's elevated worker may still be
      //    writing, so its out file is left for the next startup sweep.
      const safeToRemoveOut = Boolean(result) || (workerExited && !killed) || spawnFailed;
      await unlinkIfExists(reqPath);
      await unlinkIfExists(tokPath);
      if (safeToRemoveOut) await unlinkIfExists(outPath);
    }
  }

  return {
    /** True when applies must go through the elevated self-worker. */
    needsWorker() {
      return !elevated && inProcess !== null;
    },
    /**
     * Run one apply. Returns the {result, state} envelope the renderer
     * expects, or throws APPLY_CANCELED_ERROR when the UAC prompt was
     * canceled/denied.
     * @param {{ deviceId: number, settings: object, profileName?: string, waiverAccepted?: boolean, ocMode?: 'stock'|'advanced', profileApply?: boolean, limitsKey?: { pciDeviceId?: string|null, aibVendor?: string|null, aibModel?: string|null } | null }} req
     *   limitsKey: M17c (step-4 N6) - the PARENT-RESOLVED device identity
     *   (the parent's finalized caps AIB fields, laptop branch included).
     *   The worker's own caps decode the subsystem only, so on a laptop the
     *   parent's deviceGateThresholds could diverge from the worker's; the
     *   parent's limits-key makes the worker's gate thresholds MATCH the
     *   user-facing ones. Only present when the caller resolved one.
     */
    async apply({ deviceId, deviceKey, physicalTarget, settings, profileName, waiverAccepted, ocMode, profileApply, limitsKey }) {
      if (!this.needsWorker()) {
        if (!inProcess) throw new Error('apply runner has no in-process executor (missing inProcess deps)');
        // M4O (NEW): the IN-PROCESS branch forwards profileApply too - the
        // always-elevated packaged app's TRAY apply of a 315 W profile in
        // stock mode would otherwise refuse via executeApply's safety net
        // (caps.extendedRanges is false in stock mode). M21: the 315 W
        // profile is a PROFILE VALUE (still <= the 375 W sysman-primary
        // ceiling). Only present when
        // true (no undefined own-keys in the executor request).
        // M17d (Run D): the ocMode rides too - the executor passes it into
        // executeApply -> splitByRuntime (the V1-call pin). The callers
        // already pass the EFFECTIVE mode (the persisted ocMode for
        // interactive applies, OC_MODE_ADVANCED for profile applies). Only
        // present when the caller passed one (no undefined own-keys in the
        // executor request - the old request-shape pins stay green).
        const out = await inProcess.apply({
          deviceId,
          ...(typeof deviceKey === 'string' ? { deviceKey } : {}),
          ...(physicalTarget && typeof physicalTarget === 'object' ? { physicalTarget } : {}),
          settings,
          ...(ocMode !== undefined && ocMode !== null ? { ocMode } : {}),
          ...(profileApply === true ? { profileApply: true } : {}),
        });
        const normalized = withCapabilityFlags(out);
        return { worker: false, ...normalized };
      }
      // S2: the parent-side waiver flag rides in the request so the worker
      // restores it into its own in-memory state (apply-worker.js).
      // M3-C-E: the parent-side ocMode rides too - the worker's own backend
      // always reports extendedRanges, so ITS refusal gate is keyed on the
      // request's ocMode (a caps-keyed gate there would silently clamp).
      // M4O: the parent-side profileApply rides too - the worker skips the
      // STOCK gate for profile applies (the ceiling refusal stays). Only
      // present when true (no undefined own-keys in the request file).
      // M17c (step-4 N6): the parent-resolved limitsKey rides too - the
      // worker's gate thresholds must match the parent's (the laptop
      // branch). Only present when the caller resolved one.
      const { result } = await runWorker({
        requestId: randomUUID(),
        op: 'apply',
        deviceId,
        ...(typeof deviceKey === 'string' ? { deviceKey } : {}),
        ...(physicalTarget && typeof physicalTarget === 'object' ? { physicalTarget } : {}),
        settings,
        profileName,
        waiverAccepted,
        ocMode,
        ...(profileApply === true ? { profileApply: true } : {}),
        ...(limitsKey && typeof limitsKey === 'object' ? { limitsKey } : {}),
      });
      if (!result) throw new Error(APPLY_CANCELED_ERROR);
      if (result.ok === false && result.error) throw new Error(result.error);
      // M17c: the worker's result envelope gains the REFUSED VALUES (the
      // attempted values of the 'out-of-range' per-control results) - the
      // parent's session refused-ceiling store records from them. Only
      // present when the worker emitted them (no undefined own-keys).
      // M17g (round-3 S1): the worker's pl2Note rides the same way -
      // present -> forwarded into the renderer envelope (the PL card's
      // '(set)' session state feeds from it on the real worker path),
      // absent -> omitted (the old envelope-shape pins stay green).
      const normalized = withCapabilityFlags({
        result: {
          ok: result.ok === true,
          perControl: result.perControl ?? {},
          ...(result.refused && typeof result.refused === 'object' ? { refused: result.refused } : {}),
          ...(result.pl2Note && typeof result.pl2Note === 'object' ? { pl2Note: result.pl2Note } : {}),
        },
        state: result.state ?? null,
        ...(result.extendedUnavailable === true ? { extendedUnavailable: true } : {}),
        ...(result.extendedUnavailablePartial === true ? { extendedUnavailablePartial: true } : {}),
      });
      return {
        worker: true,
        result: normalized.result,
        state: normalized.state,
        ...(normalized.extendedUnavailable === true ? { extendedUnavailable: true } : {}),
        ...(normalized.extendedUnavailablePartial === true ? { extendedUnavailablePartial: true } : {}),
        ...(normalized.capabilityCeilingRefused === true ? { capabilityCeilingRefused: true } : {}),
        ...(normalized.capabilityCeilingPartial === true ? { capabilityCeilingPartial: true } : {}),
      };
    },
    /**
     * Accept the warranty waiver (elevated - the driver-side waiver write
     * needs the same elevation as any other OC write).
     * @param {number} deviceId
     */
    async waiverAccept(deviceId, deviceKey = null, physicalTarget = null) {
      if (!this.needsWorker()) {
        if (!inProcess) throw new Error('apply runner has no in-process executor (missing inProcess deps)');
        await inProcess.waiverAccept(deviceId, deviceKey, physicalTarget);
        return { ok: true };
      }
      const { result } = await runWorker({ requestId: randomUUID(), op: 'waiver-accept', deviceId, ...(typeof deviceKey === 'string' ? { deviceKey } : {}), ...(physicalTarget && typeof physicalTarget === 'object' ? { physicalTarget } : {}) });
      if (!result) throw new Error(APPLY_CANCELED_ERROR);
      if (result.ok !== true) throw new Error(result.error ?? 'waiver acceptance failed');
      return { ok: true };
    },
    /**
     * Reset to defaults (elevated - 0-value writes are refused even
     * elevated, so cleanup runs ctlOverclockResetToDefault).
     * @param {number} deviceId
     */
    async reset(deviceId, deviceKey = null, physicalTarget = null) {
      if (!this.needsWorker()) {
        if (!inProcess) throw new Error('apply runner has no in-process executor (missing inProcess deps)');
        const out = await inProcess.reset(deviceId, deviceKey, physicalTarget);
        return { ok: true, state: out.state };
      }
      const { result } = await runWorker({ requestId: randomUUID(), op: 'reset', deviceId, ...(typeof deviceKey === 'string' ? { deviceKey } : {}), ...(physicalTarget && typeof physicalTarget === 'object' ? { physicalTarget } : {}) });
      if (!result) throw new Error(APPLY_CANCELED_ERROR);
      if (result.ok !== true) throw new Error(result.error ?? 'reset failed');
      return { ok: true, state: result.state ?? null };
    },
    /**
     * M8 (the Graphics tab): run one graphics apply - the DEDICATED path
     * mirroring apply() (the in-process branch + the elevated worker branch
     * carrying op: 'graphics-apply'). 3D features have NO OC waiver and NO
     * OC-mode gate, so the request carries no waiverAccepted/ocMode and the
     * worker's graphics-apply op never touches the OC machinery. Returns
     * the { ok, perControl, graphicsState } envelope the renderer expects
     * (graphicsState = the FRESH read-back), or throws APPLY_CANCELED_ERROR
     * when the UAC prompt was canceled/denied.
     * @param {{ deviceId: number, settings: object }} req
     */
    async graphicsApply({ deviceId, deviceKey = null, physicalTarget = null, settings }) {
      if (!this.needsWorker()) {
        if (!inProcess) throw new Error('apply runner has no in-process executor (missing inProcess deps)');
        const out = await inProcess.graphicsApply({ deviceId, deviceKey, physicalTarget, settings });
        return { worker: false, ok: out.ok === true, perControl: out.perControl ?? {}, graphicsState: out.graphicsState ?? null };
      }
      const { result } = await runWorker({ requestId: randomUUID(), op: 'graphics-apply', deviceId, settings, ...(typeof deviceKey === 'string' ? { deviceKey } : {}), ...(physicalTarget && typeof physicalTarget === 'object' ? { physicalTarget } : {}) });
      if (!result) throw new Error(APPLY_CANCELED_ERROR);
      if (result.ok === false && result.error) throw new Error(result.error);
      return { worker: true, ok: result.ok === true, perControl: result.perControl ?? {}, graphicsState: result.graphicsState ?? null };
    },
  };
}
