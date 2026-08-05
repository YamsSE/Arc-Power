You are the step-5 FIXER in the Arc Power pipeline (fresh session). The step-5 final reviewer produced `pipeline/findings-m2a-s5-round1.md`. Fix the code findings below — each behavior-changing fix ships a regression test that fails without it.

## Context
Repo: C:\Users\Yams\Documents\R.ID Arc Power (Electron OC tool for Intel Arc; pipeline per AGENTS.md). Read `AGENTS.md`, `plan.md` §5-8/9-M2a/10, the findings file, and the M2a report `pipeline/m2a-report.md`. Baseline green: `npm test` 210/210, `npx tsc --noEmit` exit 0, `npm run smoke:mock` OK. Product name "Arc Power".

## Fix scope (findings 1, 2, 3, 4, 5, 7 — finding 6 is the host's milestone-commit job, NOT yours; do not commit)

**F1 [STRUCTURAL] Persisted waiver never consumed** — `waiver-accept` writes `waiverAccepted: true` to settings.json (src/main/ipc-core.js:186-188) but nothing reads it back into the backend's in-memory flag (src/main/backend/igcl-backend.js:68, 845), so the waiver dialog reappears on every launch. Fix: add a backend method (e.g. `restoreWaiverState(deviceId, accepted)`) that sets the in-memory flag WITHOUT calling the driver (`ctlOverclockWaiverSet` must only run on explicit user acceptance); main calls it at boot from ProfileStore.loadSettings(). MockBackend parity. Regression test: after `restoreWaiverState(true)`, an apply flow skips the dialog and no driver waiver call happens.

**F2 [STRUCTURAL] Fan clamps exist in the mock but not in IgclBackend** — `pct()` (src/main/backend/igcl-backend.js:630) only rounds; no 0–100 % clamp, no ascending-temp enforcement before `ctlFanSetSpeedTableMode` (~689-701), `fixedFanPct` unclamped. MockBackend clamps/sorts (mock-backend.js:218-224). Fix: mirror the mock's clamp+sort+ascending enforcement in `applyFan` (or a shared pure helper in units.js used by both). Regression test: fake-lib fan apply with out-of-range % and unsorted temps → clamped/sorted, and the setter receives the corrected table.

**F3 [MINOR] `resetToDefaults` has no read-back verification** — ipc-core.js:169-174, igcl-backend.js:821-832 report success without verifying. Fix: after the reset call, re-read `getCurrentSettings` and verify the OC controls moved to their capability defaults (tolerance-aware); report via ApplyResult-style result or throw on mismatch. Keep mock parity. Regression test on the fake lib + mock.

**F4 [MINOR] `snapToRange` (src/renderer/pure/slider.ts:15-23) duplicates `clampAndSnap` (src/main/backend/units.js:75-87)** — drift risk. Fix: extract one shared implementation (duplicate the pure function into renderer pure/ but keep behavior identical — a cross-layer import of main-process code into the renderer is NOT acceptable with the current build; instead make slider.ts call a shared-reimplemented helper and add a parity test comparing both on a property matrix).

**F5 [MINOR] `npm run dist` doesn't chain `build:renderer`** (package.json:18) — a stale bundle can ship. Fix: `"dist": "npm run build:renderer && electron-builder --win portable"`.

**F7 [NIT] m2a-report.md lists nonexistent `src/renderer/store.ts`** — fix the report (state cache lives in router.ts). You MAY edit m2a-report.md for this one line only; do not touch other pipeline files.

**DEFERRED (do NOT fix):** finding 6 (git commits — host's job). Also still deferred from earlier rounds: F7 fan drag perf (M2b), F11 bridge boot error (M2b), afterDialog dead export (optional, keep).

## Fix policy
- No scope creep. Do NOT commit. Keep safety rules: product paths never auto-accept the waiver; fan setters only when canControl=true; smoke stays no-op-only.
- You may run `npm start`/`--ui-verify` (mock-only). Do NOT run the real-device smoke or validation scripts (no GPU contact).

## Verification (must do, in order)
1. `npm test` — all green (expect 210 + new regression tests).
2. `npx tsc --noEmit` exit 0; `npm run build:renderer` clean.
3. `npm run smoke:mock` — SMOKE OK, state untouched.
4. `--ui-verify` (editable-fan path) — OK; waiver persistence verified: run ui-verify twice with the same mock data dir and assert the dialog does NOT appear on the second run.

## Report back
- Per finding: file:line changed + the regression test that pins it.
- Final `npm test` counts, typecheck/build status, ui-verify results (incl. the two-run waiver persistence check).
- Confirmations: no GPU contact, no commits.
