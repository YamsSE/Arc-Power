You are the step-4 FIXER in the Arc Power pipeline (fresh session). A BLOCKER was found in `src/main/igs-service.js` (see `pipeline/findings-m2a5-r2.md`). Fix it with a regression test that fails without the fix.

## The bug
`runElevatedCommand` (src/main/igs-service.js ~228-234) destructures `code` from the promise result of `promisify(execFile)`, but `promisify(execFile)` resolves as `{ stdout, stderr }` — there is NO `code` field on resolution (it only throws on non-zero exit, with `err.code`). So `code === 0` is never true and every successful elevated disable/enable returns `{ ok: false, error: 'elevation declined or timed out' }` even though the action succeeded.

## Fix
- `await execFile(...)` (resolution = exit 0) → `return { ok: true }`; catch → `classifyElevationError(err)` (existing pure classifier).
- Make `execFile` injectable in `runElevatedCommand` (constructor/opts param, mirroring how `getIgsServiceState` takes `{ execFile, probeTimeoutMs }`).
- Regression tests (in test/igs-service.test.js):
  1. success path: fake execFile that resolves → `{ ok: true }` (would return the decline string without the fix).
  2. failure path: fake execFile that rejects with `{ code: 1223 }` → `{ ok:false, error:'elevation declined or timed out' }` (proves classification still routes through the classifier).
  3. non-zero exit reject `{ code: 5 }` → `service command failed (exit 5)`.
- Keep the string-invariant tests and all existing tests green.

## Rules
- No scope creep. Do NOT commit. Do NOT run real elevation or touch the real service. Mock-only verification.

## Verification (must do, in order)
1. `npm test` — all green (expect 274 + new tests).
2. `npx tsc --noEmit` exit 0; `npm run build:renderer` clean.
3. `npm run smoke:mock` — SMOKE OK.

## Report back
- The change (file:line) + the 3 regression tests.
- Final `npm test` counts.
- Confirmations: no real service contact, no elevation run, no commits.
