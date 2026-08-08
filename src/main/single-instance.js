// Arc Power - M4-F single-instance policy gate (electron-free, unit-testable
// under plain `node --test`).
//
// The instance lock (app.requestSingleInstanceLock) applies to the UI WINDOW
// mode ONLY. Every helper mode must skip it:
//   - --headless (M1 smoke): short-lived, must never be blocked;
//   - --ui-verify: dev tooling (isolated mock data dir anyway - M3-C F4);
//   - --boot-apply (M4-E): the ELEVATED logon task's action - a second
//     instance while the UI runs must never quit silently;
//   - --apply-profile (M2b): the tray-only logon apply;
//   - --apply-worker (M2C-C S1): the elevated apply worker is a SECOND
//     instance of the app spawned WHILE the UI runs - if it failed the lock
//     it would quit without writing the out file and every elevated apply
//     would hang (hard constraint);
//   - mock-UI (RID_BACKEND=mock / --mock): consistent with the isolated
//     mock data dir philosophy (M6).
//
// The lock is userData-based: portable + installed builds share
// %APPDATA%\ArcPower, so they are mutually exclusive (expected). The dev
// tree + the packaged app share the userData too - the host/lanes must close
// one before launching the other.
//
// The acquire path is dependency-injected (requestSingleInstanceLock) so the
// held-lock failure is unit-testable without electron.

/**
 * Pure decision: should this process take the single-instance lock?
 * @param {{
 *   headless?: boolean,
 *   uiVerify?: boolean,
 *   bootApply?: boolean,
 *   applyProfileId?: string | null,
 *   workerReqFile?: string | null,
 *   mock?: boolean,
 * }} mode - the parsed CLI/env mode flags (same values main.js computes)
 * @returns {boolean}
 */
export function shouldUseInstanceLock({
  headless = false,
  uiVerify = false,
  bootApply = false,
  applyProfileId = null,
  workerReqFile = null,
  mock = false,
} = {}) {
  if (headless === true) return false;
  if (uiVerify === true) return false;
  if (bootApply === true) return false;
  if (applyProfileId !== null && applyProfileId !== undefined) return false;
  if (workerReqFile !== null && workerReqFile !== undefined) return false;
  if (mock === true) return false;
  return true;
}

/**
 * Acquire the instance lock. When the gate says skip, no lock is taken and
 * the caller proceeds (the helper's own single-instance semantics win).
 * When the gate says use and the lock is NOT acquired, another instance
 * holds it - the caller must app.quit().
 * @param {{
 *   requestSingleInstanceLock: () => boolean,
 *   mode: Parameters<typeof shouldUseInstanceLock>[0],
 * }} deps
 * @returns {{ acquired: boolean, skipped: boolean }}
 */
export function acquireInstanceLock({ requestSingleInstanceLock, mode }) {
  if (!shouldUseInstanceLock(mode)) {
    return { acquired: false, skipped: true };
  }
  return { acquired: requestSingleInstanceLock() === true, skipped: false };
}

/**
 * The second-instance focus/restore action (the tray-restore pattern, M4-D
 * Round-1 F5): a MINIMIZED window reports isVisible() === true - restore
 * first, then show + focus. Returns 'restored' | 'shown' | 'skipped' so
 * tests can pin the window-state branching without a BrowserWindow.
 * @param {{ isDestroyed: () => boolean, isMinimized: () => boolean, restore: () => void, show: () => void, focus: () => void }} win
 * @returns {'restored' | 'shown' | 'skipped'}
 */
export function focusExistingWindow(win) {
  if (!win || win.isDestroyed()) return 'skipped';
  if (win.isMinimized()) {
    win.restore();
    win.show();
    win.focus();
    return 'restored';
  }
  win.show();
  win.focus();
  return 'shown';
}
