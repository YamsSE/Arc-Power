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
