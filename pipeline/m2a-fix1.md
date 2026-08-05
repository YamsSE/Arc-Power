You are the step-4 FIXER in the Arc Power pipeline (fresh session). The step-4 reviewer approved M2a with 11 MINOR/NIT findings (`pipeline/run-m2a-review4.log`, "## FINDINGS" section). Fix the triaged subset below — each fix that changes behavior ships a regression test that fails without it.

## Context
Repo: C:\Users\Yams\Documents\R.ID Arc Power (Electron OC tool for Intel Arc; pipeline per AGENTS.md). Read `plan.md` §5-8/9-M2a/10, `AGENTS.md`, the findings in `pipeline/run-m2a-review4.log`, and the M2a report `pipeline/m2a-report.md`. Baseline green: `npm test` 187/187, `npx tsc --noEmit` exit 0, `npm run smoke:mock` OK. Product name "Arc Power".

## Fix scope (exactly these findings)

**F1 [MINOR] gpuLock unclamped** — `clampSettings` (src/main/ipc-core.js:100-109) clamps only scalar controls; `gpuLock` passes through and `applyLock` (src/main/backend/igcl-backend.js:563-593) writes `voltageV`/`freqMhz` into `ctlOverclockGpuLockSet` with no bounds check, violating the backend contract (backend.interface.js:150-151). Fix: bound `gpuLock` in `clampSettings` (voltageV to `[0, max of the gpuVoltOffsetV range]` when that range exists, freqMhz to a documented sane ceiling) AND/OR add an explicit bounds check in `applyLock`. Regression test: inject an extreme pair (e.g. voltageV=99, freqMhz=-5) through the IPC layer and assert the clamped/rejected result.

**F2 [MINOR] Fan page toasts bypass the OcErrorCode → message mapping** — src/renderer/pages/fan.ts:331 uses `per.message ?? per.errorCode ?? 'unknown error'`; the OC page (overclocking.ts:162) uses `errorMessage(per.errorCode, key)` from `pure/errors.ts`. Fix the fan page to use the same mapping.

**F3 [MINOR] Off-grid driver value renders identical to the snapped slider value** — `formatValue` (src/renderer/pure/slider.ts:40-45) rounds to 0 decimals, so 48.3 MHz renders as "48 MHz". Fix: when `isOffGrid(driverValue, range)`, render the driver line with one extra decimal (e.g. "Driver: 48.3 MHz"). Regression test in pure/slider tests.

**F4 [MINOR] "Unapplied" dirty chips go stale after a successful apply** — `refreshCard` (src/renderer/pages/overclocking.ts:59-70) compares against a render-time `state` closure that is never updated from the apply response, so chips keep showing "Unapplied" until navigation. Fix: update the current-state reference from the apply response before recomputing dirty flags (or re-render after apply). Regression test: unit-test the dirty-computation function with a fresh state after "apply" (whatever pure function you extract).

**F5 [MINOR] Curve validation accepts empty arrays and caps at 64 while the fan table is 32** — `sanitizeSettings` (src/main/ipc-core.js:73-87) and `isPointArray` (src/renderer/pure/settings.ts:27-30) accept `[]` and allow up to 64 points; `pure/curve.ts` MAX_CURVE_POINTS is 32 and the backend silently truncates 33–64. Fix: reject `length < 1` in both validators and align the cap to 32. Regression tests for both layers (IPC rejection + renderer validator).

**F6 [MINOR] Fan editor can be stuck with 0–1 points on a canControl=true device that reports no curve** — `clampPointCount(state.fanCurve ?? [], maxPoints)` (src/renderer/pages/fan.ts:64) can be `[]`/1 point; `addPointAtMidGap` needs an existing pair, so the user can never add the first point. Fix: on the editable path, if the initial curve has < 2 points, seed a default 2-point ramp ({minT, 20} → {maxT, 100}) before rendering. Regression test in pure/curve tests.

**F8 [NIT] waiver-dialog tautology** — src/renderer/components/waiver-dialog.ts:60 `afterDialog(decision).state === 'accepted' ? 'accepted' : 'cancelled'` simplifies to `return 'accepted'` (or return the state). Clean it up.

**F9 [NIT] Header status dot shows "Error" before the first health report** — `healthStatus(null)` → 'error' (src/renderer/components/header.ts:10-15). Fix: null health = neutral "Searching…" state.

**F10 [NIT] No DOM-level assertion for the off-grid driver readout** — add a `--ui-verify` step: run with a mock fixture reporting an off-grid value (e.g. 48.3 MHz) and assert the driver line renders the extra-decimal value. (See how ui-verify.js drives pages; the mock may need a fixture override knob — keep it small and mock-only.)

**DEFERRED to M2b (do NOT fix):** F7 (fan drag re-renders body per pointermove — perf), F11 (module-level `window.arcPower` access without boot error state). List them in your report as deferred with a one-line rationale.

## Fix policy
- No scope creep beyond F1–F6, F8–F10. Do NOT edit the findings/report files. Do NOT commit.
- Keep safety rules: product paths never auto-accept the waiver; fan setters only when canControl=true; smoke stays no-op-only.
- You may run `npm start`/`--ui-verify` (mock-only) and read-only commands. Do NOT run the real-device smoke or validation scripts (no GPU contact).

## Verification (must do, in order)
1. `npm test` — all green (expect 187 + new regression tests).
2. `npx tsc --noEmit` exit 0; `npm run build:renderer` clean.
3. `npm run smoke:mock` — SMOKE OK, state untouched.
4. `--ui-verify` (both editable-fan and `RID_MOCK_FAN_READONLY=1` paths) — OK, including your new off-grid step.

## Report back
- Per finding: file:line changed + the regression test that pins it.
- Final `npm test` counts, typecheck/build status, ui-verify results.
- Confirmations: no GPU contact, no commits, deferred findings F7/F11 noted.
