// Arc Power - M2C-C apply-worker (`--apply-worker <reqFile> <outFile>`).
//
// The elevated self-worker: reads the request JSON, runs the SAME routed
// instant-apply core as the UI path (apply-routing.js) plus the runtime
// routing, then writes the result JSON and exits. The worker:
//   - never creates a window or tray (hidden by construction - main.js
//     enters this branch before any UI setup);
//   - never re-elevates (it IS the elevated process - spawning another
//     elevated instance would be pointless);
//   - exits after writing the result file (exit 0 = result written, even
//     for an apply failure - the parent reads the honest result).
//
// Electron-free: the whole contract is testable under plain node --test.

import fs from 'node:fs';
import path from 'node:path';
import { sanitizeSettings, clampSettings, sanitizeGraphicsSettings } from './ipc-core.js';
import { executeApply, ocModeRefusal, refusalPerControl, extendedUnavailableRefusal, extendedUnavailablePerControl, wcUnitControls, EXTENDED_UNAVAILABLE_MSG, OC_MODE_STOCK, OC_MODE_ADVANCED } from './apply-routing.js';

/**
 * M2 orphan guard: refuse to run when the request directory holds an
 * EXPIRED parent-owned token (`arcpower-tok-<requestId>.json` written by
 * the parent with an expiresAt). An expired token means the parent already
 * gave up (timeout/crash) before this worker started - applying anyway
 * would land a write the user was told was canceled.
 *
 * M1 (step-5): the guard is PER-REQUEST, not per-directory - only the token
 * belonging to THIS request may block. The token is matched by its
 * `requestId` field (or, failing that, its filename suffix) against the
 * request's own id; a foreign leftover from another request's crashed
 * parent must not produce a confusing "superseded" refusal. With no
 * requestId to correlate, nothing blocks (the startup sweep owns cleanup).
 * @param {string} dir request-file directory
 * @param {string | null} requestId this request's id (null = no correlation)
 * @param {number} [now]
 * @param {string} [tokenPrefix] token filename prefix (M17i: the sysman
 *   helper's tokens are `arcpower-sm-tok-<id>.json` - the same guard, the
 *   sm- family)
 * @returns {Promise<string | null>} the stale token's path, or null
 */
export async function findStaleSiblingToken(dir, requestId, now = Date.now(), tokenPrefix = 'arcpower-tok-') {
  let files;
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return null; // no dir - nothing to judge
  }
  for (const f of files) {
    if (!f.startsWith(tokenPrefix) || !f.endsWith('.json')) continue;
    let tok;
    try {
      tok = JSON.parse(await fs.promises.readFile(path.join(dir, f), 'utf8'));
    } catch {
      continue; // unreadable token - not ours to judge
    }
    if (typeof requestId === 'string' && requestId !== '') {
      const tokId = typeof tok.requestId === 'string' ? tok.requestId : f.slice(tokenPrefix.length, -'.json'.length);
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
 *   sysmanPowerLimits?: object | null, // M17f: the sysman PL2 companion -
 *   // null -> no companion (tests); main.js wires the real adapter
 * }} deps
 * @returns {Promise<number>} process exit code (0 = result written)
 */
export async function runApplyWorker({ reqPath, outPath, backend, oldIgcl, log = () => {}, sysmanPowerLimits = null }) {
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
  if (!['apply', 'waiver-accept', 'reset', 'graphics-apply'].includes(op)) {
    await finish({ ok: false, error: `invalid request: unknown op '${op}'` });
    return 1;
  }

  // M2 orphan guard: the parent writes a token with an expiry BEFORE
  // spawning; an already-expired token FOR THIS REQUEST means the parent
  // gave up (timeout/crash) before this worker started - refuse to apply so
  // the write can never land after the user was told the apply was canceled.
  // M1: per-request correlation - the parent keys its token by the SAME id
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
    // worker only ever seeds the IN-MEMORY flag (restoreWaiverState - never
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

    // M8 (the Graphics tab): the DEDICATED graphics apply op - 3D features
    // have NO OC waiver and NO OC-mode gate, so this branch never touches
    // the OC machinery (no sanitizeSettings, no ocModeRefusal, no
    // extended-unavailable refusal). The worker's own sanitizer validates
    // the payload (the FPS clamp uses the device's FRESH frame-limit range,
    // 30-300-1-60 fallback); the response envelope is { ok, perControl,
    // graphicsState } with the FRESH getGraphicsSettings read-back for the
    // page's per-control refresh.
    if (op === 'graphics-apply') {
      if (typeof req.settings !== 'object' || req.settings === null || Array.isArray(req.settings)) {
        await finish({ ok: false, error: 'invalid request: settings must be an object' });
        return 1;
      }
      let range = null;
      try {
        range = (await backend.getGraphicsSettings(deviceId)).frameLimitRange;
      } catch {
        // degraded - the sanitizer's fallback applies
      }
      const settings = sanitizeGraphicsSettings(req.settings, range);
      const out = await backend.setGraphicsSettings(deviceId, settings);
      let graphicsState = null;
      try { graphicsState = await backend.getGraphicsSettings(deviceId); } catch { /* degraded */ }
      await finish({ ok: out.ok, perControl: out.perControl, graphicsState });
      return 0;
    }

    // op === 'apply' - the routed instant-apply core (clamps internally via
    // executeApply, routes extended values to the 2023 runtime).
    if (typeof req.settings !== 'object' || req.settings === null || Array.isArray(req.settings)) {
      await finish({ ok: false, error: 'invalid request: settings must be an object' });
      return 1;
    }
    const settings = sanitizeSettings(req.settings);
    // M3-C-E: the OC-mode gate runs BEFORE the clamp. The request carries
    // the parent's ocMode - the worker's own caps always report the mode's
    // extended ranges (its backend is pinned to advanced by main.js), so a
    // caps-keyed MODE gate here would silently clamp extended values in
    // stock mode: exactly the forbidden behavior. The gate's refusal reports
    // the mode message only and never touches the GPU (no defaults restore
    // downstream - the parent's applyProfile path gates BEFORE delegating,
    // and a direct worker request refuses here the same way).
    // M4-E: the gate is unit-aware - it receives the capability RANGES
    // (a device property from the same probe as the parent), so percent-unit
    // devices are never mode-refused. NOT the extendedRanges flag.
    // M4O: a profileApply request (the profile paths pass profileApply:true)
    // SKIPS the STOCK gate - the mode is the interactive slider gate ONLY,
    // a saved profile applies as saved (the parent's applyProfile already
    // gated on the runtime capability). The CEILING refusal STAYS - a
    // hand-edited above-ceiling profileApply reaching the worker directly
    // must never silently clamp (the worker's caps max IS the sysman-
    // primary 375 W on the a770, so the flagless skip would clamp silently
    // - the forbidden class).
    const caps = await backend.getCapabilities(deviceId);
    // M17c: the DEVICE-SCOPED gate thresholds - the caps carry the device
    // identity (pciDeviceId/aibVendor/aibModel - resolved from the
    // worker's OWN post-M17c caps enumeration, round-2 N7), which the
    // ocModeRefusal limits-key resolves from the pure device-limits table
    // (the listed rows' ceilings for listed cards, the default row for
    // unlisted - never caps.ranges).
    // M17c (step-4 N6): the request MAY carry the PARENT-RESOLVED
    // limits-key (req.limitsKey - the parent's finalized caps AIB fields,
    // laptop branch included). The worker's own caps decode the subsystem
    // only, so on a laptop the parent's thresholds could diverge (the
    // portable branch overrides the decode parent-side); the parent's
    // limits-key makes the worker's gate match the user-facing surface.
    // Absent -> the worker's own caps (the historical behavior).
    const limitsKey = req.limitsKey && typeof req.limitsKey === 'object'
      ? {
          pciDeviceId: req.limitsKey.pciDeviceId ?? null,
          aibVendor: req.limitsKey.aibVendor ?? null,
          aibModel: req.limitsKey.aibModel ?? null,
        }
      : null;
    // M17d (Run D): the APPLY MODE is the same value ocModeRefusal receives
    // (the request's ocMode for interactive applies, OC_MODE_ADVANCED for
    // profile applies - a profile applies as saved) and the same value
    // threaded into executeApply -> splitByRuntime (the V1-call pin: an
    // advanced-mode PL/TL apply must route through the bundled 2023
    // runtime's V1 setters, never fall through to the DriverStore path).
    const applyMode = req.profileApply === true ? OC_MODE_ADVANCED : (req.ocMode === OC_MODE_ADVANCED ? OC_MODE_ADVANCED : OC_MODE_STOCK);
    const refusal = ocModeRefusal(applyMode, settings, caps.ranges, limitsKey ?? caps);
    if (refusal) {
      log(`[apply-worker] oc-mode refusal: ${refusal.message} (${refusal.controls.join(', ')})`);
      // M3-C review F2: the refusal carries the FRESH device state, never
      // null - the parent renderer stores the envelope's state into its
      // store (a null would null the store's device state and crash the
      // dirty helpers). The refusal never touched the GPU, so the read-back
      // is the state before the refused apply. Degraded to null only if the
      // read itself fails.
      let state = null;
      try { state = await backend.getCurrentSettings(deviceId); } catch { /* degraded */ }
      await finish({ ok: false, perControl: refusalPerControl(refusal), state, ocModeRefused: true });
      return 0;
    }
    // M3-C step-5 F1: advanced mode + a NOT-capable bundled 2023 runtime on
    // THIS driver -> refuse extended values BEFORE the clamp, never a silent
    // 252 W / 90 C cap reported as ok:true. Safe here: the worker's backend
    // derives caps from the SAME isCapable probe as the parent, so keying on
    // caps.extendedRanges is a capability refusal - not the caps-keyed mode
    // gate the plan forbids. The refusal never touches the GPU and carries
    // the fresh state.
    // M17d (step-4 N1): the in-range profileApply W/C refusal mirror - a
    // profile apply is advanced-gated, so its W/C values route through the
    // bundled 2023 runtime (V1) REGARDLESS of value. On a not-capable
    // runtime an IN-RANGE value (e.g. 240 W) must refuse with the same
    // capability refusal class the parents emit (apply-on-boot.js /
    // ipc-core.js - never the per-control 'unsupported' the V1 setter
    // answers, which the parent classifies as a failed apply, not the
    // refusal class).
    let unavailable = extendedUnavailableRefusal(settings, caps);
    if (!unavailable && req.profileApply === true && caps.extendedRanges !== true) {
      const wc = wcUnitControls(settings, caps.ranges);
      if (wc.length > 0) unavailable = { controls: wc, message: EXTENDED_UNAVAILABLE_MSG };
    }
    if (unavailable) {
      log(`[apply-worker] extended-unavailable refusal: ${unavailable.message} (${unavailable.controls.join(', ')}) - nothing applied`);
      let state = null;
      try { state = await backend.getCurrentSettings(deviceId); } catch { /* degraded */ }
      await finish({ ok: false, perControl: extendedUnavailablePerControl(unavailable.controls), state, extendedUnavailable: true });
      return 0;
    }
    const clamped = clampSettings(settings, caps.ranges);
    const out = await executeApply({ backend, oldIgcl, deviceId, settings: clamped, log, ocMode: applyMode, sysmanPowerLimits });
    // M17c: the result envelope gains the REFUSED VALUES (round-2 S7 +
    // round-3 N1): the attempted values of the 'out-of-range' per-control
    // results - the parent's session refused-ceiling store records from
    // them (the worker's own store evaporates; the parent's caps are the
    // ones the renderer sees). The parent clamps with ITS caps, the worker
    // with ITS OWN - so the envelope carries the values the worker ACTUALLY
    // attempted, never a guess. Emitted only when non-empty (the old
    // envelope shape pins stay green; an absent `refused` falls back to
    // the parent's attempted settings).
    const refused = {};
    for (const [control, per] of Object.entries(out.result.perControl)) {
      if (per?.ok === false && per?.errorCode === 'out-of-range'
        && typeof clamped[control] === 'number' && Number.isFinite(clamped[control])) {
        refused[control] = clamped[control];
      }
    }
    await finish({
      ok: out.result.ok,
      perControl: out.result.perControl,
      state: out.state,
      ...(Object.keys(refused).length > 0 ? { refused } : {}),
      // M17g (round-3 S1): the pl2Note rides the worker envelope the same
      // way as `refused` - ABSENT when null (the old envelope-shape pins
      // stay green). The parent's elevated-apply normalization forwards it
      // into the renderer envelope - without the forwarding the real
      // worker path would silently show '-' on the PL card.
      ...(out.result.pl2Note ? { pl2Note: out.result.pl2Note } : {}),
    });
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
