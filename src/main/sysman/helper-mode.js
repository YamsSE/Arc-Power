// Arc Power - M17i the sysman-helper mode (`--sysman-helper <reqFile>
// <outFile>`): the dedicated IGCL-free process for the sysman power-limits
// consumer. The measured root cause (plan M17i): the consumer's zesInit
// fails with ERROR_UNINITIALIZED ONLY when the IGCL is loaded inside an
// ELECTRON process - the packaged app (requireAdministrator) runs its
// applies in-process = electron + IGCL = the poisoned combo. The consumer
// therefore runs HERE, in a process that loads ONLY the consumer (NO
// backend, NO OldIgcl, NO IGCL - the bare-context zesInit path, proven by
// the M17i diagnostic ladder). The parent's proxy (helper-proxy.js) writes
// the request + the parent-owned token, spawns this mode directly (the
// helper INHERITS the parent's elevation) and polls the out file.
//
// Contract:
//   request file  (JSON): { id, op: 'read' } | { id, op: 'set',
//                           sustainedW, burstW }
//   token file    (JSON): { requestId, expiresAt } - written by the parent
//                           BEFORE the request file; the parent-owned
//                           timeout marker the stale-token guard keys off.
//   result file   (JSON): { id, ok: true, sustainedW?, burstW?, peakW? } |
//                          { id, ok: false, errorCode?, message? }
//   - all three files are keyed by the SAME id
//     (arcpower-sm-req-<id>.json / arcpower-sm-tok-<id>.json /
//     arcpower-sm-out-<id>.json);
//   - the result file is ALWAYS written before exiting (even for a refusal
//     - the parent polls the out file, never the exit code);
//   - exit 0 = the dispatch ran + the result written (a consumer failure is
//     still a written honest result); exit 1 = the request could not be
//     honored at all (unreadable / unknown op / stale token).
//
// Electron-free: the consumer is INJECTED (the seam that makes the whole
// contract testable under plain node --test - main.js wires the real
// createSysmanPowerLimits({})).

import fs from 'node:fs';
import path from 'node:path';
import { findStaleSiblingToken } from '../apply-worker.js';

/**
 * Run one sysman-helper request and exit.
 * @param {{
 *   reqPath: string,
 *   outPath: string,
 *   consumer: {
 *     readLimits: (deviceId?: number) => { sustainedW: number, burstW: number, peakW: number } | null | Promise<...>,
 *     setLimits: ({ sustainedW: number, burstW: number }) => { ok: boolean, errorCode?: string, message?: string } | Promise<...>,
 *   },
 *   log?: (s: string) => void,
 * }} deps
 * @returns {Promise<number>} process exit code (0 = dispatch ran + result written)
 */
export async function runSysmanHelperMode({ reqPath, outPath, consumer, log = () => {} }) {
  const reqBaseName = path.basename(reqPath);
  const reqNameMatch = reqBaseName.match(/^arcpower-sm-req-(.+)\.json$/);
  let req = null;
  try {
    const raw = await fs.promises.readFile(reqPath, 'utf8');
    req = JSON.parse(raw);
  } catch (err) {
    log(`request unreadable: ${err.message}`);
    await writeOut(outPath, { ok: false, errorCode: 'request-unreadable', message: `request unreadable: ${err.message}` }, reqNameMatch ? reqNameMatch[1] : null);
    return 1;
  }
  const id = typeof req?.id === 'string' && req.id !== '' ? req.id : (reqNameMatch ? reqNameMatch[1] : null);
  const op = req?.op;

  // M17i stale-token guard (the findStaleSiblingToken pattern,
  // apply-worker.js:99-114): the parent writes the arcpower-sm-tok-<id>
  // token with an expiry BEFORE spawning; an already-expired token FOR THIS
  // id means the parent gave up (timeout/crash) before this helper started
  // - refuse so a late write can never land after the parent reported a
  // failure. The id is derived from the request content or, failing that,
  // the request filename (arcpower-sm-req-<id>.json).
  const staleToken = await findStaleSiblingToken(path.dirname(reqPath), id, Date.now(), 'arcpower-sm-tok-');
  if (staleToken) {
    log(`refusing to run: stale parent token ${path.basename(staleToken)} (the parent gave up)`);
    await writeOut(outPath, { ok: false, errorCode: 'superseded', message: 'request superseded: the parent process gave up before this helper started' }, id);
    return 1;
  }

  if (op === 'read') {
    // The read dispatch: readLimits -> { ok: true, sustainedW?, burstW?,
    // peakW? } | { ok: false, errorCode?, message? } - a null read (the
    // consumer's honest degrade) becomes the unavailable refusal.
    let limits = null;
    try {
      limits = await consumer.readLimits();
    } catch (err) {
      log(`readLimits failed: ${err.message}`);
    }
    if (limits && typeof limits === 'object') {
      await writeOut(outPath, { ok: true, ...limits }, id);
      return 0;
    }
    await writeOut(outPath, { ok: false, errorCode: 'unavailable', message: 'the sysman power-limits read returned no limits (the consumer is unavailable)' }, id);
    return 0;
  }

  if (op === 'set') {
    // The set dispatch: the setLimits result rides VERBATIM (round-1 N2) -
    // the consumer's errorCode/message are never remapped (the
    // refused-class taxonomy at apply-routing.js keys on the exact codes).
    // Step-5 N2: the pair is finite-guarded BEFORE the call (a garbage
    // payload would otherwise reach the consumer's own invalid-argument
    // path - defensive, unreachable in practice: the proxy builds the req).
    const sustainedW = req.sustainedW;
    const burstW = req.burstW;
    if (!Number.isFinite(sustainedW) || !Number.isFinite(burstW)) {
      await writeOut(outPath, { ok: false, errorCode: 'invalid-argument', message: 'sustainedW and burstW must be finite numbers' }, id);
      return 1;
    }
    let result = null;
    try {
      result = await consumer.setLimits({ sustainedW, burstW });
    } catch (err) {
      log(`setLimits failed: ${err.message}`);
      result = { ok: false, errorCode: 'io-failed', message: err.message };
    }
    if (!result || typeof result !== 'object') {
      result = { ok: false, errorCode: 'io-failed', message: 'the setLimits call returned no result' };
    }
    await writeOut(outPath, result, id);
    return 0;
  }

  log(`invalid request: unknown op '${String(op)}'`);
  await writeOut(outPath, { ok: false, errorCode: 'invalid-op', message: `invalid request: unknown op '${String(op)}'` }, id);
  return 1;
}

/**
 * Write the result file (atomic-ish: the write AFTER the dispatch - the
 * parent polls the file, so it must never observe a placeholder).
 */
async function writeOut(outPath, payload, id) {
  try {
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  } catch { /* dir exists */ }
  const body = typeof id === 'string' && id !== '' ? { id, ...payload } : payload;
  await fs.promises.writeFile(outPath, JSON.stringify(body), 'utf8');
}
