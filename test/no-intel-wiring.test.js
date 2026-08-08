// Round-1 no-Intel fix regressions — source-order pins (same technique as
// main-wiring.test.js: the pinned modules import electron / DOM and cannot
// be imported under plain node --test, and the live --ui-verify cannot catch
// these by itself — no toast can fire on the no-Intel path by construction,
// so only the ORDER of the pin vs. the clear proves the regression is gone).
//
// Pin 1 (findings-nointel-1.md #1): the no-intel variant's no-toast pin ran
// AFTER `clearToasts()`, so a toast fired earlier in the session (e.g. during
// boot) was removed instead of caught — the pin only covered the final
// ~1.2 s window. The no-toast assertion must run BEFORE any clear, with the
// post-window re-assert kept.
//
// Pin 2 (findings-nointel-1.md #2): on no-Intel both deviceId and caps/state
// are null, and the `!caps || !state` guard sat BEFORE the
// `s.deviceId === null` guard — the Tuning page rendered a perpetual
// 'Loading device capabilities…' instead of the honest 'No GPU available.'.
// The deviceId-null guard must run first. (Live pin: the no-intel --ui-verify
// variant asserts the Tuning page text — ui-verify.js step 7.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const uiVerifySrc = fs.readFileSync(fileURLToPath(new URL('../src/main/ui-verify.js', import.meta.url)), 'utf8');
const tuningSrc = fs.readFileSync(fileURLToPath(new URL('../src/renderer/pages/tuning.ts', import.meta.url)), 'utf8');

function findIndex(src, needle, from = 0) {
  const idx = src.indexOf(needle, from);
  assert.notEqual(idx, -1, `needle not found: ${needle}`);
  return idx;
}

test('no-intel ui-verify: the no-toast assertion runs BEFORE clearToasts() (a boot-time toast must fail the verify, not be swallowed)', () => {
  // Scope to the no-intel variant body (each variant declares its own
  // clearToasts helper; only runNoIntelVerify is pinned here).
  const start = findIndex(uiVerifySrc, 'export async function runNoIntelVerify');
  const end = findIndex(uiVerifySrc, 'UI VERIFY OK (no-intel)', start);
  const body = uiVerifySrc.slice(start, end);
  const toastPin = findIndex(body, "!!document.querySelector('.toast')");
  const clearCall = findIndex(body, 'clearToasts()');
  assert.ok(
    toastPin < clearCall,
    `ordering: the no-toast assertion (ui-verify.js:${toastPin}) must precede clearToasts() (ui-verify.js:${clearCall}) — a toast that fired earlier in the session must fail the verify, not be removed by the clear`,
  );
  // The post-window re-assert stays (the pin covers the final telemetry
  // ticks after the clear) — exactly two no-toast assertions in the variant.
  const second = findIndex(body, "!!document.querySelector('.toast')", toastPin + 1);
  assert.ok(
    second > clearCall,
    'the post-window no-toast re-assert must still run after clearToasts()',
  );
  assert.equal(
    body.indexOf("!!document.querySelector('.toast')", second + 1),
    -1,
    'exactly two no-toast assertions are expected in the no-intel variant (pre-clear pin + post-window re-assert)',
  );
});

test('no-intel tuning page: the deviceId-null guard runs BEFORE the caps/state guard (no GPU available, never a perpetual loading text)', () => {
  // Scope to the render() guards region of tuningPage (the apply paths use
  // different needles: `deviceId === null || !caps`).
  const start = findIndex(tuningSrc, 'export const tuningPage: Page = {');
  const end = findIndex(tuningSrc, 'onUpdate(container', start);
  const body = tuningSrc.slice(start, end);
  const deviceGuard = findIndex(body, 'if (s.deviceId === null) {');
  const capsGuard = findIndex(body, 'if (!caps || !state) {');
  assert.ok(
    deviceGuard < capsGuard,
    `ordering: the deviceId-null guard (tuning.ts:${deviceGuard}) must precede the caps/state guard (tuning.ts:${capsGuard}) — on no-Intel the page must say 'No GPU available.', never 'Loading device capabilities…' forever`,
  );
  // The deviceId guard's message is the honest one.
  const msgIdx = findIndex(body, 'No GPU available.', deviceGuard);
  assert.ok(
    msgIdx < capsGuard,
    'the deviceId-null branch must render the \'No GPU available.\' text',
  );
});
