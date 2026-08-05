You are the step-4 reviewer in the Arc Power pipeline. Milestone M1 (core backend) was just implemented. **You report findings with fixing suggestions only — you never edit code, never run fixes.** A separate agent will fix what you find.

## Context
Repo: C:\Users\Yams\Documents\R.ID Arc Power (Electron OC tool for Intel Arc GPUs; pipeline per AGENTS.md — step 4 = findings-only reviewer + separate fresh fixer). Read `plan.md` (sections 5-7, 9-M1, 10), `AGENTS.md`, and `docs/igcl-integration.md` first. M1 deliverables are under `src/main/` (backend/, telemetry/, store/, main.js, smoke.js, health.js) plus `test/*.test.js` (9 files, 112 tests) and package.json. The product was renamed "Arc Power" — that is intentional, not a defect.

## What to review (findings only — no edits)
1. `IOCBackend` contract (src/main/backend/backend.interface.js) vs plan §7 and the actual implementations (igcl-backend.js, mock-backend.js, index.js). Watch for: signature drift between the JSDoc interface and implementations (e.g. an `applySettings` third opts param claimed in the implementer report but not in the interface docs), unit conventions (canonical W/V/MHz/°C/% everywhere), the waiver gate (`allowAutoWaiter` only in smoke/tests; product path never auto-accepts), fan setters only when `canControl === true`.
2. IgclBackend vs docs/igcl-integration.md + tools/probe (the verified reference): struct definitions reused correctly, zero-UID init, DriverStore re-scan, V2 API + capability-unit conversion, clamp+read-back applies, telemetry mapping, error-code mapping (igclErrorCode).
3. TelemetryService: 500 ms cadence respecting the 50 ms IGCL limit, power-from-energy derivation guarding dt<=0 and energy wraps, ring buffer, unsubscribe.
4. ProfileStore + migrations: atomic writes (temp+rename), migration purity, refusal of unknown/newer schema versions, the waiverAccepted/ocOnBoot/activeProfileId settings slot.
5. Safety: no-op applies only in smoke; reset only if a change was detected; no GPU state changes in tests/smoke.
6. Tests: do the 112 tests actually pin the risky behavior (struct marshalling fixtures, no-op round trips, atomic write crash simulation, migration fixtures, waiver never auto-accepted in product construction)?

## Verification you may run (read-only)
- `npm test` (expect 112 pass — if it is not green, say so immediately, that is a blocker).
- `npm run smoke:mock` (mock backend, no hardware, no state changes).
- Do NOT run the real-device smoke or touch the GPU; that is the fixer/implementer's job after your findings are addressed.

## Output format
- FINDINGS: numbered list, each tagged [BLOCKER] / [STRUCTURAL] / [MINOR] / [NIT], with file:line references and a concrete suggested fix.
- VERDICT: exactly one final line: `VERDICT: APPROVED` or `VERDICT: CHANGES REQUIRED`.
If a round's remaining findings are only MINOR/NIT-level (no behavior change), emit VERDICT: APPROVED and list them for triage.
