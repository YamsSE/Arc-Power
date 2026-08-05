You are the step-4 FIXER (fresh session) in the Arc Power pipeline. The step-4 gate verified the step-5 fixes and found 2 new MINORs. Fix both — each with a regression test that fails without it.

## Context
Repo: C:\Users\Yams\Documents\R.ID Arc Power (Electron OC tool for Intel Arc; pipeline per AGENTS.md). Read `AGENTS.md`, the verification notes in `pipeline/run-m2a-s5gate.log` (the '## FINDINGS' section near the end), and the code regions cited. Baseline green: `npm test` 225/225, `npx tsc --noEmit` exit 0, `npm run smoke:mock` OK. Product name "Arc Power".

## Fix scope

**G1 [MINOR] `restoreWaiverState` missing from the IOCBackend contract typedef** — src/main/backend/backend.interface.js:153-171: both backends implement `restoreWaiverState(deviceId, accepted)` and ipc-core.js:136 depends on it, but the `IOCBackend` typedef doesn't declare it. Fix: add `restoreWaiverState(deviceId: number, accepted: boolean): Promise<void>` to the typedef with a doc comment: sets ONLY the in-memory waiver flag, NEVER calls the driver — the contract distinction from `setWaiverAccepted`. Also check mock-backend/igcl-backend method docs mention it (minor doc alignment). Regression test: a type/contract sanity test asserting all IOCBackend typedef methods exist on both backends (list the expected method names in the test; restoreWaiverState must be among them).

**G2 [MINOR] No reconciliation when the driver-level waiver is lost** — persisted `waiverAccepted: true` seeds the in-memory flag at boot (F1), so if the driver ever loses the waiver (driver reinstall, IGS reset) while settings.json still says accepted, every apply fails with `waiver-not-set` and the dialog can never re-trigger (caps.waiverAccepted stays true; no re-accept path). Fix: on an apply result containing any perControl `errorCode === 'waiver-not-set'`, clear the in-memory flag (`restoreWaiverState(deviceId, false)`) — in the backend's applySettings (so every backend-using path heals) or in the ipc-core apply handler (single place). Also clear the cached `caps.waiverAccepted` so the renderer re-shows the dialog on the next apply. Regression test: fake-lib apply returns waiver-not-set → subsequent `getCapabilities().waiverAccepted === false` and the next apply's waiver-gate path calls the driver waiver set when accepted again.

## Fix policy
- No scope creep. Do NOT commit. Keep safety rules: product paths never auto-accept the waiver (clearing the flag is NOT acceptance; re-accept still requires the explicit dialog + waiver-accept channel); fan setters only when canControl=true.
- Mock parity for any backend behavior change (mock-backend should mirror the waiver-lost clearing).
- You may run `npm start`/`--ui-verify` (mock-only). Do NOT run the real-device smoke or validation scripts (no GPU contact).

## Verification (must do, in order)
1. `npm test` — all green (expect 225 + new regression tests).
2. `npx tsc --noEmit` exit 0; `npm run build:renderer` clean.
3. `npm run smoke:mock` — SMOKE OK, state untouched.
4. `--ui-verify` editable-fan path — OK (two-run waiver persistence still passes).

## Report back
- Per finding: file:line changed + the regression test that pins it.
- Final `npm test` counts, typecheck/build status, ui-verify results.
- Confirmations: no GPU contact, no commits.
