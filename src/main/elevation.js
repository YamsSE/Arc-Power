// Arc Power - M2C-C elevation detection (main process).
//
// Detects whether the current process runs with administrator privileges via
// shell32's IsUserAnAdmin (a single koffi call - NO process spawn, cached
// after the first call). The elevation gate is the root cause of the
// momentary-lie: non-elevated IGCL OC writes return SUCCESS with a momentary
// read-back match and then revert (docs/igcl-integration.md §8c), so the app
// must know its own elevation to decide between in-process apply and the
// elevated apply-worker.
//
// Electron-free (plain koffi) so tests can inject a fake lib; the worker
// mode and the boot task share this helper.

import koffi from 'koffi';

let cached = null;

/**
 * Detect elevation once, cache forever. Never throws: a detection failure is
 * returned as { elevated: false, verified: false } so callers can keep the
 * safe non-admin behavior without confusing an unknown probe with a verified
 * non-admin process.
 * @param {{ lib?: object, koffiMod?: object }} [deps] - injectable for tests
 * @returns {{ elevated: boolean, verified: boolean }}
 */
export function getElevationStatus({ lib: libDep, koffiMod = koffi } = {}) {
  if (cached !== null) return { ...cached };
  try {
    const lib = libDep ?? koffiMod.load('shell32.dll');
    // IsUserAnAdmin returns BOOL (4 bytes) - bind as int32, not the 1-byte
    // koffi 'bool', to avoid a truncated register read.
    const isUserAnAdmin = lib.func('int32 IsUserAnAdmin(void)');
    cached = { elevated: isUserAnAdmin() !== 0, verified: true };
  } catch {
    cached = { elevated: false, verified: false };
  }
  return { ...cached };
}

/** Return only the elevation bit for existing apply/elevation callers. */
export function isElevated(deps = {}) {
  return getElevationStatus(deps).elevated === true;
}

/**
 * Test hook: reset the cache (fresh session only - product code never calls
 * this; the cache is intentionally process-long).
 */
export function resetElevationCache() {
  cached = null;
}
