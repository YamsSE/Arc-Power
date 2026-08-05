// Arc Power — M2C-C apply-worker (`--apply-worker <reqFile> <outFile>`).
//
// The elevated self-worker: reads the request JSON, runs the SAME routed
// instant-apply core as the UI path (apply-routing.js) plus the runtime
// routing, then writes the result JSON and exits. The worker:
//   - never creates a window or tray (hidden by construction — main.js
//     enters this branch before any UI setup);
//   - never re-elevates (it IS the elevated process — spawning another
//     elevated instance would be pointless);
//   - exits after writing the result file (exit 0 = result written, even
//     for an apply failure — the parent reads the honest result).
//
// Electron-free: the whole contract is testable under plain node --test.

import fs from 'node:fs';
import path from 'node:path';
import { sanitizeSettings, clampSettings } from './ipc-core.js';
import { executeApply } from './apply-routing.js';

/**
 * M2 orphan guard: refuse to run when the request directory holds an
 * EXPIRED parent-owned token (`arcpower-tok-<requestId>.json` written by
 * the parent with an expiresAt). An expired token means the parent already
 * gave up (timeout/crash) before this worker started — applying anyway
 * would land a write the user was told was canceled.
 *
 * M1 (step-5): the guard is PER-REQUEST, not per-directory — only the token
 * belonging to THIS request may block. The token is matched by its
 * `requestId` field (or, failing that, its filename suffix) against the
 * request's own id; a foreign leftover from another request's crashed
 * parent must not produce a confusing "superseded" refusal. With no
 * requestId to correlate, nothing blocks (the startup sweep owns cleanup).
 * @param {string} dir request-file directory
 * @param {string | null} requestId this request's id (null = no correlation)
 * @param {number} [now]
 * @returns {Promise<string | null>} the stale token's path, or null
 */
export async function findStaleSiblingToken(dir, requestId, now = Date.now()) {
  let files;
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return null; // no dir — nothing to judge
  }
  for (const f of files) {
    if (!f.startsWith('arcpower-tok-') || !f.endsWith('.json')) continue;
    let tok;
    try {
      tok = JSON.parse(await fs.promises.readFile(path.join(dir, f), 'utf8'));
    } catch {
      continue; // unreadable token — not ours to judge
    }
    if (typeof requestId === 'string' && requestId !== '') {
      const tokId = typeof tok.requestId === 'string' ? tok.requestId : f.slice('arcpower-tok-'.length, -'.json'.length);
      if (tokId !== requestId) continue;
    }
    if (typeof tok.expiresAt === 'number' && tok.expiresAt < now) return path.join(dir, f);
  }
  return null;
}

/**
 * @param {{
 *   reqPath: string,
 *   outPath: string,
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   oldIgcl: object,
 *   log?: (s: string) => void,
 * }} deps
 * @returns {Promise<number>} process exit code (0 = result written)
 */
export async function runApplyWorker({ reqPath, outPath, backend, oldIgcl, log = () => {} }) {
  let req;
  try {
    const raw = await fs.promises.readFile(reqPath, 'utf8');
    req = JSON.parse(raw);
  } catch (err) {
    log(`[apply-worker] request unreadable: ${err.message}`);
    await writeResult(outPath, { ok: false, error: `request unreadable: ${err.message}` });
    return 1;
  }
  const requestId = typeof req?.requestId === 'string' ? req.requestId : null;
  const op = req?.op ?? 'apply';
  const deviceId = Number.isInteger(req?.deviceId) && req.deviceId >= 0 ? req.deviceId : null;
  const finish = async (payload) => {
    await writeResult(outPath, { requestId, op, ...payload });
  };
  if (deviceId === null) {
    await finish({ ok: false, error: 'invalid request: deviceId must be a non-negative integer' });
    return 1;
  }
  if (!['apply', 'waiver-accept', 'reset'].includes(op)) {
    await finish({ ok: false, error: `invalid request: unknown op '${op}'` });
    return 1;
  }

  // M2 orphan guard: the parent writes a token with an expiry BEFORE
  // spawning; an already-expired token FOR THIS REQUEST means the parent
  // gave up (timeout/crash) before this worker started — refuse to apply so
  // the write can never land after the user was told the apply was canceled.
  // M1: per-request correlation — the parent keys its token by the SAME id
  // it stamped on our request file, so a foreign leftover's expired token
  // never blocks this request (and vice versa). Derive the id from our own
  // file name when the request content lacks one (the runner always writes
  // arcpower-req-<id>.json).
  const reqBaseName = path.basename(reqPath);
  const reqNameMatch = reqBaseName.match(/^arcpower-req-(.+)\.json$/);
  const tokenRequestId = requestId ?? (reqNameMatch ? reqNameMatch[1] : null);
  const staleToken = await findStaleSiblingToken(path.dirname(reqPath), tokenRequestId);
  if (staleToken) {
    log(`[apply-worker] refusing to run: stale parent token ${path.basename(staleToken)} (the parent gave up)`);
    await finish({ ok: false, error: 'request superseded: the parent process gave up before this worker started' });
    return 1;
  }

  try {
    await backend.init();
    // The parent already accepted the waiver through the user dialog; the
    // worker only ever seeds the IN-MEMORY flag (restoreWaiverState — never
    // ctlOverclockWaiverSet, which runs only on explicit user acceptance
    // via the waiver-accept op).
    if (req.waiverAccepted === true) {
      await backend.restoreWaiverState(deviceId, true);
    }

    if (op === 'waiver-accept') {
      await backend.setWaiverAccepted(deviceId);
      await finish({ ok: true });
      return 0;
    }

    if (op === 'reset') {
      await backend.resetToDefaults(deviceId);
      let state = null;
      try { state = await backend.getCurrentSettings(deviceId); } catch { /* degraded */ }
      await finish({ ok: true, state });
      return 0;
    }

    // op === 'apply' — the routed instant-apply core (clamps internally via
    // executeApply, routes extended values to the 2023 runtime).
    if (typeof req.settings !== 'object' || req.settings === null || Array.isArray(req.settings)) {
      await finish({ ok: false, error: 'invalid request: settings must be an object' });
      return 1;
    }
    const settings = sanitizeSettings(req.settings);
    const caps = await backend.getCapabilities(deviceId);
    const clamped = clampSettings(settings, caps.ranges);
    const out = await executeApply({ backend, oldIgcl, deviceId, settings: clamped, log });
    await finish({ ok: out.result.ok, perControl: out.result.perControl, state: out.state });
    return 0;
  } catch (err) {
    log(`[apply-worker] FAILED: ${err.message}`);
    await finish({ ok: false, error: err.message });
    return 1;
  } finally {
    try { await backend.close(); } catch { /* best effort */ }
    try { await oldIgcl?.close?.(); } catch { /* best effort */ }
  }
}

async function writeResult(outPath, payload) {
  try {
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  } catch { /* dir exists */ }
  await fs.promises.writeFile(outPath, JSON.stringify(payload), 'utf8');
}
