// Arc Power - M17i the sysman-helper proxy: the parent-side client of the
// `--sysman-helper` mode. The measured root cause (plan M17i): the sysman
// consumer's zesInit fails with ERROR_UNINITIALIZED ONLY when the IGCL is
// loaded inside an ELECTRON process, so the consumer must run in a dedicated
// helper process that loads ONLY the consumer (no backend, no OldIgcl, no
// IGCL - the bare-context zesInit path). This proxy mirrors the consumer
// contract (readLimits/setLimits - the runSysmanCompanion + the
// 'power-limits:read' channel are unchanged) while delegating every call to
// one helper spawn:
//   - the spawn is DIRECT child_process.spawn (NO PowerShell, NO -Verb
//     RunAs) - the helper INHERITS the parent's elevation (the packaged
//     EXE's requireAdministrator token / the runas worker's token / the
//     dev tree's unelevated process); only the app-arg/working-dir
//     convention transfers from the elevated-apply runner;
//   - each call = the pre-spawn sweep + the token + the request write +
//     the spawn + the out poll (~30 s) + the parse;
//   - the failure degrades (pre-spawn write fail / spawn fail / timeout /
//     unreadable out) -> readLimits null / setLimits { ok: false,
//     errorCode: 'helper-failed', message } - the honest degrade, never a
//     throw.
//
// The COST (round-1 N3): an apply = 2 spawns (the companion's setLimits +
// the movement re-read) -> ~2-6 s per apply; the read-out = 1 spawn; the
// cadence stays per-apply/boot only (never per telemetry tick).
//
// Electron-free: the spawn + the sweep + the tempDir are INJECTED seams so
// the whole contract is testable under plain node --test.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn as childProcessSpawn } from 'node:child_process';
import { sweepStaleWorkerFiles, writeJsonFile, TOKEN_TTL_MS } from '../elevated-apply.js';

// The out poll window: the helper's zesInit + the read/write round trip
// take ~1-6 s live (round-1 N3); 30 s covers the slowest legit spawn.
export const HELPER_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 200;

async function unlinkIfExists(filePath) {
  try {
    await fs.promises.unlink(filePath);
    return 1;
  } catch {
    return 0;
  }
}

/**
 * Poll the out file until the helper writes it, the helper exits without
 * one, or the timeout fires (the helper is then killed - best effort).
 * @param {string} outPath
 * @param {{ on?: Function, kill?: Function } | null} child
 * @param {number} timeoutMs
 * @param {(s: string) => void} log
 * @returns {Promise<{ out: object | null, killed: boolean }>}
 */
function pollForOut(outPath, child, timeoutMs, log) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let killed = false;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ out, killed });
    };
    timer = setTimeout(() => {
      log('out poll TIMED OUT - killing the helper');
      killed = true;
      try { child?.kill?.(); } catch { /* best effort */ }
      finish(null);
    }, timeoutMs);
    const tick = async () => {
      if (settled) return;
      let out = null;
      try {
        const raw = await fs.promises.readFile(outPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') out = parsed;
      } catch { /* not written / torn yet - keep polling */ }
      if (out) { finish(out); return; }
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    if (child && typeof child.on === 'function') {
      child.on('error', () => finish(null));
      child.on('exit', () => {
        // The helper ALWAYS writes the out file before exiting - an exit
        // with no readable out = the helper failed (spawn error/crash).
        // One final read after the exit event (the writes are flushed by
        // then), then degrade.
        setTimeout(async () => {
          if (settled) return;
          try {
            const raw = await fs.promises.readFile(outPath, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') { finish(parsed); return; }
          } catch { /* torn/absent */ }
          finish(null);
        }, 100);
      });
    }
    tick();
  });
}

/**
 * Create the sysman-helper proxy.
 * @param {{
 *   execPath?: string,             // our executable (default process.execPath)
 *   appPath?: string | null,       // dev-mode electron app dir (null = packaged EXE)
 *   tempDir?: () => string,        // the shared temp dir (default os.tmpdir)
 *   sweep?: (dir: string) => Promise<number>,  // the pre-spawn sweep
 *   spawnFn?: (cmd: string, args: string[], opts: object) => object, // the spawn seam
 *   timeoutMs?: number,            // the out poll window (default HELPER_TIMEOUT_MS)
 *   log?: (s: string) => void,
 * }} deps
 */
export function createSysmanHelperProxy({
  execPath = process.execPath,
  appPath = null,
  tempDir = () => os.tmpdir(),
  sweep = sweepStaleWorkerFiles,
  spawnFn = childProcessSpawn,
  timeoutMs = HELPER_TIMEOUT_MS,
  log = () => {},
} = {}) {
  const spawn = spawnFn;

  /**
   * One helper round trip: the sweep + the token + the request write + the
   * DIRECT spawn + the out poll + the parse.
   * @param {{ op: 'read' | 'set', payload?: object }} call
   * @returns {Promise<{ out: object | null, reason: string | null }>}
   */
  async function runCall({ op, payload }) {
    // A unique id per call - the req/out/tok triple is keyed by it (the
    // same randomUUID pattern as the apply runner).
    const id = randomUUID();
    const dir = tempDir();
    const reqPath = path.join(dir, `arcpower-sm-req-${id}.json`);
    const outPath = path.join(dir, `arcpower-sm-out-${id}.json`);
    const tokPath = path.join(dir, `arcpower-sm-tok-${id}.json`);
    let out = null;
    let killed = false;
    let reason = null;
    try {
      // (a) the pre-spawn sweep of a crashed parent's leftovers (the
      // packaged app never runs runWorker, so the proxy is the sweep's
      // only invocation site there - round-1 S5).
      // (b) the parent-owned token BEFORE the request file - the helper's
      // stale-token guard keys on it; its expiry bounds how long the
      // helper is allowed to start after the parent gave up (the
      // elevated-apply TOKEN_TTL_MS semantics).
      // (c) the request file (arcpower-sm-req-<id>.json).
      // The never-throw contract (round-1 N1): the pre-spawn I/O sits
      // OUTSIDE the spawn's own catch - a throwing sweep seam or a
      // temp-dir write failure would otherwise propagate out of
      // readLimits/setLimits. Any failure here degrades to the honest
      // helper-failed path instead - never a throw.
      try {
        await sweep(dir);
        await writeJsonFile(tokPath, { requestId: id, expiresAt: Date.now() + TOKEN_TTL_MS });
        await writeJsonFile(reqPath, { id, op, ...payload });
      } catch (err) {
        log(`pre-spawn write failed: ${err.message}`);
        reason = `the sysman helper could not be started (pre-spawn file write failed: ${err.message})`;
      }
      if (!reason) {
        // (d) the DIRECT spawn - no PowerShell, no -Verb RunAs: the helper
        // INHERITS the parent token. Dev-tree args `['.', '--sysman-helper',
        // reqPath, outPath]` with cwd: appPath (the elevated-apply
        // convention - the '.' avoids the space-in-arg quoting trap); the
        // packaged EXE needs no app path (round-1 S4).
        let child = null;
        try {
          child = await spawn(
            execPath,
            appPath ? ['.', '--sysman-helper', reqPath, outPath] : ['--sysman-helper', reqPath, outPath],
            appPath ? { cwd: appPath, windowsHide: true, stdio: 'ignore' } : { windowsHide: true, stdio: 'ignore' },
          );
        } catch (err) {
          log(`spawn failed: ${err.message}`);
          reason = `the sysman helper could not be spawned (${err.message})`;
        }
        if (!reason) {
          // (e) the out poll + (f) the parse.
          const res = await pollForOut(outPath, child, timeoutMs, log);
          out = res.out;
          killed = res.killed;
          if (!out) reason = 'the sysman helper produced no result file (spawn failure, crash, or timeout)';
        }
      }
      return { out, reason };
    } finally {
      // The req + the token are always removed; the out file is removed
      // after a successful read or a VISIBLE helper exit (a killed helper
      // may still be writing - its out file is left for the next pre-spawn
      // sweep, the orphan-policy pattern).
      await unlinkIfExists(reqPath);
      await unlinkIfExists(tokPath);
      if (out || !killed) await unlinkIfExists(outPath);
    }
  }

  return {
    /**
     * M17f (step-4 N2): the deviceId is ACCEPTED for the mock-scoped
     * contract and IGNORED - the consumer is device-agnostic (the real
     * layer resolves the one enumerated card power domain).
     * @param {number} [deviceId]
     * @returns {Promise<{ sustainedW: number, burstW: number, peakW: number } | null>}
     */
    async readLimits(deviceId) {
      const { out } = await runCall({ op: 'read' });
      if (out?.ok === true
        && typeof out.sustainedW === 'number'
        && typeof out.burstW === 'number'
        && typeof out.peakW === 'number') {
        return { sustainedW: out.sustainedW, burstW: out.burstW, peakW: out.peakW };
      }
      return null;
    },
    /**
     * Write the sustained + burst pair through the helper. The helper's
     * errorCode/message ride VERBATIM (round-1 N2 - no remap, or the
     * refused-class taxonomy at apply-routing.js silently degrades to the
     * generic 'failed' note). A failed delegation (spawn fail / timeout /
     * unreadable out) answers the honest 'helper-failed' degrade.
     * @param {{ sustainedW: number, burstW: number }} limits
     * @returns {Promise<{ ok: boolean, errorCode?: string, message?: string }>}
     */
    async setLimits({ sustainedW, burstW }) {
      const { out, reason } = await runCall({ op: 'set', payload: { sustainedW, burstW } });
      if (!out) return { ok: false, errorCode: 'helper-failed', message: reason ?? 'the sysman helper produced no result' };
      const result = { ok: out.ok === true };
      if (out.errorCode !== undefined) result.errorCode = out.errorCode;
      if (out.message !== undefined) result.message = out.message;
      return result;
    },
  };
}
