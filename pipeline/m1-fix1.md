You are the step-4 FIXER in the Arc Power pipeline. A findings-only reviewer produced `pipeline/findings-m1-round1.md`. Your job: fix EVERY finding, ship a regression test for each behavior-changing fix, and prove the suite is green. You are a fresh session — read the findings file, the code, and fix.

## Context
Repo: C:\Users\Yams\Documents\R.ID Arc Power (Electron OC tool for Intel Arc GPUs; pipeline per AGENTS.md — step 4 = findings-only reviewer + separate fresh fixer, and you are the fixer). Read `AGENTS.md`, `plan.md` §5-7/9-M1/10, `docs/igcl-integration.md`, and the findings file first. Product name is "Arc Power". M0/M1 green baseline: `npm test` 112/112, `npm run smoke:mock` green.

## Fix policy
- Fix every finding F1–F7. Each fix that changes behavior needs a regression test that would fail without the fix (F1: the fan-apply path with `canControl=true` must not throw; F2: fan/VF-curve applies must read back and verify before reporting `readBackEqual` — use the fake-lib/`MockBackend` fixtures; F4: `Capabilities.fan.modes` must use canonical `auto|curve|fixed`; F3: document `applySettings` opts in the JSDoc; F5: pick one temp-unit string (`'C'` or `'°C'`) and align code+docs; F6: fsync before rename in `_writeAtomic`; F7: `getCapabilities` must not hand out a mutable cached object).
- Do NOT fix anything outside the findings (no scope creep). Do NOT edit the findings file. Do NOT commit.
- Keep `--headless` smoke semantics: no-op applies only, reset only if a change was detected, fan setters only when `canControl === true`, waiver auto-accept only under `allowAutoWaiver` (smoke/tests).
- The M2a milestone is about to build on this code — leave the contract clean and the docs (`backend.interface.js` JSDoc) matching the implementations.

## Verification (must do, in order)
1. `npm test` — all green (expect 112 + your new regression tests).
2. `npm run smoke:mock` — green, state untouched.
3. Inspect the changed files once more for consistency (imports, JSDoc, units).
4. Do NOT run the real-device smoke and do NOT touch the GPU — not your job in this pass.

## Report back
- Per finding: what you changed (file:line) and the regression test that pins it.
- Final `npm test` counts + smoke:mock result.
- Any finding you chose not to fix (must be justified as out-of-scope/not-a-defect; if you disagree with a finding, say so explicitly and why — the reviewer will see it in the verify round).
