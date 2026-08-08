// M4-F — the single-instance policy gate (pure, electron-free):
//   - the gate TABLE: UI mode acquires; every helper — --headless,
//     --ui-verify, --boot-apply, --apply-profile, --apply-worker, mock-UI —
//     skips;
//   - the held-lock FAILURE: a second instance (requestSingleInstanceLock
//     false) is reported as not-acquired so the caller quits;
//   - --apply-worker is EXCLUDED by construction (the S1 hard constraint:
//     the elevated apply worker is a SECOND instance spawned WHILE the UI
//     runs — a failed lock there would quit without writing the out file);
//   - the second-instance focus/restore action (the tray-restore pattern).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseInstanceLock, acquireInstanceLock, focusExistingWindow } from '../src/main/single-instance.js';

// ---------------------------------------------------------------------------
// The gate table
// ---------------------------------------------------------------------------

test('gate: plain UI mode takes the lock', () => {
  assert.equal(shouldUseInstanceLock({}), true, 'no flags = the UI window mode');
  assert.equal(shouldUseInstanceLock({ headless: false, uiVerify: false, bootApply: false, applyProfileId: null, workerReqFile: null, mock: false }), true);
});

test('gate: --headless skips', () => {
  assert.equal(shouldUseInstanceLock({ headless: true }), false);
  assert.equal(shouldUseInstanceLock({ headless: true, uiVerify: false }), false);
});

test('gate: --ui-verify skips', () => {
  assert.equal(shouldUseInstanceLock({ uiVerify: true }), false);
});

test('gate: --boot-apply skips (the elevated logon task runs while the UI may run)', () => {
  assert.equal(shouldUseInstanceLock({ bootApply: true }), false);
});

test('gate: --apply-profile skips', () => {
  assert.equal(shouldUseInstanceLock({ applyProfileId: 'p1' }), false);
});

test('gate: --apply-worker skips — the S1 hard constraint (a failed lock would hang every elevated apply)', () => {
  assert.equal(shouldUseInstanceLock({ workerReqFile: 'C:\\req.json' }), false);
  // Both worker args present — still skipped.
  assert.equal(shouldUseInstanceLock({ workerReqFile: 'req.json', headless: false }), false);
});

test('gate: mock-UI (RID_BACKEND=mock / --mock) skips', () => {
  assert.equal(shouldUseInstanceLock({ mock: true }), false);
  // A mock session with every UI flag absent still skips.
  assert.equal(shouldUseInstanceLock({ uiVerify: false, mock: true }), false);
});

test('gate: a helper flag wins over the UI mode even when others are absent', () => {
  // One helper at a time must each be sufficient to skip.
  assert.equal(shouldUseInstanceLock({ bootApply: true, mock: false }), false);
  assert.equal(shouldUseInstanceLock({ applyProfileId: 'x', mock: false }), false);
  assert.equal(shouldUseInstanceLock({ workerReqFile: 'x', mock: false }), false);
  assert.equal(shouldUseInstanceLock({ uiVerify: true, mock: false }), false);
  assert.equal(shouldUseInstanceLock({ headless: true, mock: false }), false);
});

// ---------------------------------------------------------------------------
// The acquire path (dependency-injected — no electron)
// ---------------------------------------------------------------------------

test('acquire: UI mode + free lock -> acquired (the caller proceeds)', () => {
  const { acquired, skipped } = acquireInstanceLock({
    requestSingleInstanceLock: () => true,
    mode: {},
  });
  assert.equal(acquired, true);
  assert.equal(skipped, false);
});

test('acquire: UI mode + HELD lock -> not acquired (the caller must app.quit)', () => {
  const { acquired, skipped } = acquireInstanceLock({
    requestSingleInstanceLock: () => false,
    mode: {},
  });
  assert.equal(acquired, false);
  assert.equal(skipped, false);
});

test('acquire: a helper mode never calls requestSingleInstanceLock (skipped)', () => {
  let calls = 0;
  for (const mode of [
    { headless: true },
    { uiVerify: true },
    { bootApply: true },
    { applyProfileId: 'p1' },
    { workerReqFile: 'req' },
    { mock: true },
  ]) {
    const { acquired, skipped } = acquireInstanceLock({
      requestSingleInstanceLock: () => { calls += 1; return true; },
      mode,
    });
    assert.equal(acquired, false, JSON.stringify(mode));
    assert.equal(skipped, true, JSON.stringify(mode));
  }
  assert.equal(calls, 0, 'the lock function must never be called for a helper mode');
});

test('acquire: --apply-worker is excluded even with an EMPTY req path edge (never a lock on the worker)', () => {
  // The worker mode is keyed on the req-file argument being present — the
  // gate must exclude it before any electron call.
  const { acquired, skipped } = acquireInstanceLock({
    requestSingleInstanceLock: () => { throw new Error('must not be called'); },
    mode: { workerReqFile: '', applyProfileId: null, headless: false, uiVerify: false, bootApply: false, mock: false },
  });
  assert.equal(acquired, false);
  assert.equal(skipped, true);
});

// ---------------------------------------------------------------------------
// The second-instance focus/restore action (the tray-restore pattern)
// ---------------------------------------------------------------------------

function fakeWin({ destroyed = false, minimized = false } = {}) {
  const actions = [];
  return {
    actions,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: () => actions.push('restore'),
    show: () => actions.push('show'),
    focus: () => actions.push('focus'),
  };
}

test('second-instance: a MINIMIZED window is restored FIRST (the tray-restore pattern)', () => {
  const win = fakeWin({ minimized: true });
  assert.equal(focusExistingWindow(win), 'restored');
  assert.deepEqual(win.actions, ['restore', 'show', 'focus']);
});

test('second-instance: a visible window is shown + focused', () => {
  const win = fakeWin();
  assert.equal(focusExistingWindow(win), 'shown');
  assert.deepEqual(win.actions, ['show', 'focus']);
});

test('second-instance: a destroyed/absent window is skipped (no crash before the window exists)', () => {
  assert.equal(focusExistingWindow(null), 'skipped');
  const win = fakeWin({ destroyed: true });
  assert.equal(focusExistingWindow(win), 'skipped');
  assert.deepEqual(win.actions, []);
});
