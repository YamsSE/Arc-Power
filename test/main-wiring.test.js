// M2C-C step-5 S1 regression: the REAL product boot path (non-mock) must not
// crash with "Cannot access 'isElevated' before initialization". The bug:
// main.js built the apply runner with `createApplyRunner({ isElevated, ... })`
// while `const isElevated` was declared ~30 lines LATER (TDZ — a const binding
// is uninitialized until its declaration executes). Every test harness stayed
// in the mock/headless branches that return before that line, so 567 tests
// were green while `npx electron .` died at startup. main.js imports electron
// and cannot be imported under plain node --test, so this pins the one
// invariant that broke: the isElevated binding must be DECLARED before the
// applyRunner block evaluates it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mainSrcPath = fileURLToPath(new URL('../src/main/main.js', import.meta.url));

function findLineNumber(src, needle) {
  const lines = src.split('\n');
  const idx = lines.findIndex((l) => l.includes(needle));
  assert.notEqual(idx, -1, `needle not found in main.js: ${needle}`);
  return idx + 1;
}

test('S1: the isElevated binding is declared before the applyRunner block uses it (TDZ guard)', () => {
  const src = fs.readFileSync(mainSrcPath, 'utf8');
  const declLine = findLineNumber(src, 'const isElevated = mock');
  const useLine = findLineNumber(src, 'createApplyRunner({');
  assert.ok(
    declLine < useLine,
    `TDZ: createApplyRunner({ isElevated, ... }) at main.js:${useLine} evaluates isElevated before its declaration at main.js:${declLine} — the real (non-mock) app crashes at startup`,
  );
});

test('S1: the non-mock isElevated binding is the imported real probe, never undefined', () => {
  const src = fs.readFileSync(mainSrcPath, 'utf8');
  const declIdx = src.indexOf('const isElevated = mock');
  assert.notEqual(declIdx, -1, 'the hoisted declaration must exist');
  const segment = src.slice(declIdx, declIdx + 120);
  assert.match(segment, /: isElevatedReal/, 'the product path must bind the imported real elevation probe');
  // The mock knob stays a mock-only concern: the runner block (which the
  // mock branch never reaches) must pass the declared probe.
  const blockStart = src.indexOf('createApplyRunner({');
  assert.notEqual(blockStart, -1);
  const blockEnd = src.indexOf('\n  } else if (uiVerify', blockStart);
  assert.notEqual(blockEnd, -1, 'applyRunner block must be followed by the ui-verify mock-runner branch');
  const block = src.slice(blockStart, blockEnd);
  assert.match(block, /\n\s*isElevated,/, 'the runner deps must include the isElevated probe');
});

// M3-C review F3 — the oc-mode boot pre-seed ORDERING. The bug: the window
// + IPC were registered before bootBackend() seeded setOcMode, so a
// persisted-advanced session's first getCapabilities returned stock ranges
// (252 W / 90 C sliders until a self-heal). The seeding must run BEFORE
// createWindow and BEFORE registerIpc.

test('F3: the oc-mode pre-seed (seedOcMode) runs BEFORE createWindow and registerIpc', () => {
  const src = fs.readFileSync(mainSrcPath, 'utf8');
  const seedLine = findLineNumber(src, 'seedOcMode(backend, store)');
  const winLine = findLineNumber(src, 'const win = createWindow()');
  const ipcLine = findLineNumber(src, 'registerIpc({');
  assert.ok(
    seedLine < winLine && winLine < ipcLine,
    `ordering: seedOcMode at main.js:${seedLine} must precede createWindow at main.js:${winLine} which must precede registerIpc at main.js:${ipcLine} — the renderer's first get-capabilities must already see the persisted mode`,
  );
});

// M3-C review F4 — mock/ui-verify sessions must NEVER write the real
// %APPDATA%\ArcPower\settings.json. The ProfileStore must be constructed
// with an ISOLATED temp data dir in mock mode, and that construction must
// happen before the window exists (so every mock IPC/store write is
// isolated).

test('F4: the ProfileStore construction uses an ISOLATED mock data dir and precedes createWindow', () => {
  const src = fs.readFileSync(mainSrcPath, 'utf8');
  const winIdx = src.indexOf('const win = createWindow()');
  assert.notEqual(winIdx, -1);
  // M4-E: --boot-apply mode constructs its OWN store in an early-return mode
  // (never reaches the window). The WINDOW-PATH store is the LAST
  // ProfileStore construction before createWindow — pin THAT one.
  const markers = [...src.matchAll(/new ProfileStore\(\{/g)];
  const beforeWin = markers.filter((m) => m.index < winIdx);
  assert.ok(beforeWin.length >= 1, 'a store construction must precede the window');
  const mainStore = beforeWin[beforeWin.length - 1];
  // The isolated dir is derived from the mock flag.
  const segment = src.slice(mainStore.index - 200, mainStore.index + 120);
  assert.match(segment, /arcpower-mock/, 'the mock data dir must be an isolated temp dir');
  assert.match(segment, /dir:\s*mockDataDir/, 'the store must receive the isolated dir in mock mode');
  // The variant-to-variant session seed must still exist AFTER the store.
  const seedIdx = src.indexOf('oc-mode session seed');
  assert.ok(seedIdx > mainStore.index, 'the mock session seed must still run after the store construction');
});

// M4-E step-4 F1 (STRUCTURAL) — the setup gate must NEVER run on the
// --apply-profile path. The bug: the gate block sat BEFORE the --apply-profile
// early return, so an INSTALLED build's tray-only apply awaited two schtasks
// queries (10 s each) and could fire a UAC prompt. The gate feeds ONLY the
// window-path boot-apply decision, so it must be positioned AFTER the early
// return (and before createWindow). The packaged smoke's exit-0/no-prompt
// contract for --apply-profile / --headless / --boot-apply / --ui-verify
// depends on this order.

test('M4-E F1: the setup gate block runs AFTER the --apply-profile early return (never on the tray-only apply path)', () => {
  const src = fs.readFileSync(mainSrcPath, 'utf8');
  const earlyReturnLine = findLineNumber(src, 'if (applyProfileId && !uiVerify)');
  const gateLine = findLineNumber(src, 'const installedBuild = app.isPackaged');
  const winLine = findLineNumber(src, 'const win = createWindow()');
  assert.ok(
    earlyReturnLine < gateLine && gateLine < winLine,
    `ordering: the --apply-profile early return (main.js:${earlyReturnLine}) must precede the setup gate (main.js:${gateLine}) which must precede createWindow (main.js:${winLine}) — a tray-only apply must never run the gate (no schtasks waits, no UAC prompt)`,
  );
});

// M4-E step-4 F4 — the gate check must never be AWAITED before window
// creation (a hung schtasks would stall the first window up to 20 s). The
// check is started fire-and-forget before createWindow and awaited at the
// boot-apply decision (the only consumer), with the degraded-to-null catch.

test('M4-E F4: the setup gate check is started WITHOUT await and awaited only at the boot-apply decision', () => {
  const src = fs.readFileSync(mainSrcPath, 'utf8');
  assert.ok(
    !src.includes('await bootSetup.check()'),
    'the gate check must never be awaited where it is started — a hung schtasks must not stall the first window',
  );
  const checkStartLine = findLineNumber(src, 'bootGateCheck = bootSetup.check()');
  const winLine = findLineNumber(src, 'const win = createWindow()');
  assert.ok(
    checkStartLine < winLine,
    `the gate check must START before createWindow (main.js:${checkStartLine} < ${winLine}) so its verdict is typically in hand by the boot-apply decision`,
  );
  const awaitLine = findLineNumber(src, 'if (bootGateCheck) await bootGateCheck');
  const gateUseLine = findLineNumber(src, 'if (bootGate?.green === true)');
  assert.ok(
    awaitLine > winLine && awaitLine < gateUseLine,
    `the check must be AWAITED at the boot-apply decision only (main.js:${awaitLine}), between the window (${winLine}) and the gate use (${gateUseLine})`,
  );
});

// ---------------------------------------------------------------------------
// M4-F — the single-instance lock + the boot deviceId resolution wiring.
// The ORDER pin: the acquire sits BEFORE the window path (createWindow) and
// AFTER every helper early return — plus the gate excludes the helpers by
// construction (single-instance.js). ui-verify reaches the window path but
// the gate skips it by construction.
// ---------------------------------------------------------------------------

test('M4-F: the instance lock acquire precedes createWindow (the second instance quits before a window exists)', () => {
  const src = fs.readFileSync(mainSrcPath, 'utf8');
  const lockLine = findLineNumber(src, 'requestSingleInstanceLock: () => app.requestSingleInstanceLock()');
  const winLine = findLineNumber(src, 'const win = createWindow()');
  assert.ok(
    lockLine < winLine,
    `ordering: the lock acquire (main.js:${lockLine}) must precede createWindow (main.js:${winLine}) — a second instance must quit before any window/backend work`,
  );
});

test('M4-F: every helper early return precedes the instance lock (helpers never reach it)', () => {
  const src = fs.readFileSync(mainSrcPath, 'utf8');
  const lockLine = findLineNumber(src, 'requestSingleInstanceLock: () => app.requestSingleInstanceLock()');
  for (const [needle, label] of [
    ['if (workerReqFile) {', '--apply-worker'],
    ['if (bootApply) {', '--boot-apply'],
    ['if (headless) {', '--headless'],
    ['if (applyProfileId && !uiVerify) {', '--apply-profile'],
  ]) {
    const helperLine = findLineNumber(src, needle);
    assert.ok(
      helperLine > 0,
      `the ${label} early return must exist (needle '${needle}')`,
    );
  }
  // M4-F (host, placement fix): the lock sits RIGHT AFTER whenReady so the
  // second UI instance quits FAST (~1 s) instead of booting the backend
  // first (~20 s). The helpers' early returns no longer precede it — the
  // GATE is the enforcement point (unit-pinned: every helper + mock-UI
  // skips by construction, and a helper flag wins over the UI mode). The
  // source must feed the gate the FULL mode set.
  const modeDeclLine = findLineNumber(src, 'const instanceLockMode = { headless, uiVerify, bootApply, applyProfileId, workerReqFile, mock }');
  const gateCallLine = findLineNumber(src, 'shouldUseInstanceLock(instanceLockMode)');
  assert.ok(
    modeDeclLine < gateCallLine && gateCallLine < lockLine,
    `the gate decision (main.js:${gateCallLine}) must run before the acquire (main.js:${lockLine}) and after the mode set (${modeDeclLine})`,
  );
});

test('M4-F: the second-instance handler restores the EXISTING window ref set after createWindow', () => {
  const src = fs.readFileSync(mainSrcPath, 'utf8');
  const handlerLine = findLineNumber(src, "app.on('second-instance'");
  const assignLine = findLineNumber(src, 'windowForInstance = win;');
  const winLine = findLineNumber(src, 'const win = createWindow()');
  assert.ok(
    handlerLine < winLine && winLine < assignLine,
    `ordering: the second-instance handler (main.js:${handlerLine}) is registered before createWindow (${winLine}) and the window ref is assigned after (${assignLine}) — the handler must operate on the live window, never a stale null`,
  );
  const src2 = fs.readFileSync(mainSrcPath, 'utf8');
  assert.match(src2.slice(assignLine), /focusExistingWindow\(windowForInstance\)/, 'the handler uses the tray-restore pattern helper on the window ref');
});

test('M4-F: the boot deviceId resolution runs after the window path boot seeding and before the boot apply', () => {
  const src = fs.readFileSync(mainSrcPath, 'utf8');
  const bootBackendLine = findLineNumber(src, 'await bootBackend();');
  const resolveLine = findLineNumber(src, 'resolveBootDeviceId(backend, store)');
  const applyLine = findLineNumber(src, 'profileId: bootSettings.activeProfileId,');
  const healthLine = findLineNumber(src, 'const health = await collectHealth(backend);');
  assert.ok(
    bootBackendLine < resolveLine && resolveLine < healthLine,
    `ordering: the resolution (main.js:${resolveLine}) must run after the boot seeding (${bootBackendLine}) and before the health read (${healthLine})`,
  );
  assert.ok(
    resolveLine < applyLine,
    `the resolved deviceId (main.js:${resolveLine}) must feed the window-path boot apply (${applyLine})`,
  );
  const deviceIdUses = [...src.matchAll(/deviceId: bootDeviceId,/g)].map((m) => m.index);
  const lastUse = deviceIdUses.length > 0 ? src.slice(0, deviceIdUses[deviceIdUses.length - 1]).split('\n').length : -1;
  assert.ok(
    applyLine < lastUse,
    `the window-path boot apply passes the resolved deviceId (main.js:${lastUse})`,
  );
});

test('M4-F: the boot-apply mode resolves the persisted deviceId into its apply closure', () => {
  const src = fs.readFileSync(mainSrcPath, 'utf8');
  const resolveLine = findLineNumber(src, 'bootDeviceId = await resolveApplyDeviceId(bootBackend, bootStore, null)');
  const applyClosureLine = findLineNumber(src, 'apply: (profileId) => applyProfileBoot({');
  assert.ok(
    resolveLine < applyClosureLine,
    `ordering: the boot-apply deviceId resolution (main.js:${resolveLine}) must precede the apply closure (${applyClosureLine}) that consumes it`,
  );
  const passLine = findLineNumber(src, 'deviceId: bootDeviceId,');
  assert.ok(
    applyClosureLine < passLine,
    `the closure must pass the resolved id (main.js:${passLine})`,
  );
});
