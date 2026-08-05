You are the step-4 reviewer in the Arc Power pipeline. Milestone M2a (UI core) was just implemented. **You report findings with fixing suggestions only — you never edit code, never run fixes.** A separate fresh agent will fix what you find.

## Context
Repo: C:\Users\Yams\Documents\R.ID Arc Power (Electron OC tool for Intel Arc GPUs; pipeline per AGENTS.md — step 4 = findings-only reviewer + separate fresh fixer). Read `plan.md` (sections 5, 6, 7, 8, 9-M2a, 10), `AGENTS.md`, `docs/igcl-integration.md`, the M2a report `pipeline/m2a-report.md`, and the M1 code first. M2a was implemented as a TypeScript renderer + IPC seam on top of the M1 main-process backend. Baseline: `npm test` 187/187, typecheck clean, smoke:mock + real-device smoke green.

## What to review (findings only — no edits)
1. **IPC security surface** (src/preload.cjs, src/main/ipc.js, src/main/ipc-core.js): channel whitelist, payload validation (deviceId int, settings keys ⊆ CONTROLS, finite numbers, well-formed arrays/objects), re-clamping in main before the backend, no raw object passthrough, sandbox/contextIsolation intact in main.js. The no-auto-waiver product path (renderer can never trigger waiver auto-accept).
2. **Renderer architecture** (src/renderer/): framework-free, typed; pure/ modules are the testable core; router/pages/components are thin DOM glue. Check the waiver state machine (dialog before first apply, persist via ProfileStore, no second dialog, Cancel aborts), the slider snap math vs capability steps, off-grid driver-value display (A770 ~48.3 MHz case), preset computation within ranges, error-toast mapping of every OcErrorCode, fan editor logic (point clamp to maxCurvePoints, ascending-temp enforcement, add/remove) and the read-only path when canControl=false.
3. **Backend wiring** (main.js, ipc): TelemetryService start/stop ownership, per-window sender isolation, teardown on close. `--headless` smoke and `--ui-verify` still work; no regression to M1 behavior (no-op applies only in smoke).
4. **Safety**: values clamped in BOTH renderer and main; no GPU state change except the dev validation scripts which restore; waiver only via explicit user acceptance in product paths; fan setters only when canControl=true.
5. **Tests**: 75 new tests — do they pin the risky behavior (payload validation rejections, no-auto-waiver, clamp-before-apply, snap math incl. off-grid read-back display, fan clamp/sort, error mapping, waiver dialog state machine, N1/N2 regression tests)?

## Verification you may run (read-only)
- `npm test` (expect 187 pass — if not green, that is a blocker), `npx tsc --noEmit`, `npm run build:renderer`, `npm run smoke:mock`, and `npm start` briefly to confirm the window loads (kill it after).
- Do NOT touch the real GPU (no `npm run smoke`, no validation scripts). That is the fixer/implementer's job.

## Output format
- FINDINGS: numbered list, each tagged [BLOCKER] / [STRUCTURAL] / [MINOR] / [NIT], with file:line references and a concrete suggested fix.
- VERDICT: exactly one final line: `VERDICT: APPROVED` or `VERDICT: CHANGES REQUIRED`.
If a round's remaining findings are only MINOR/NIT-level (no behavior change), emit VERDICT: APPROVED and list them for triage.
