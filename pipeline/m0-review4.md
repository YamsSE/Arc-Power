You are the step-4 reviewer/fixer in the Arc Power pipeline. Milestone M0 (IGCL validation probe) has just been implemented. Your job: review the M0 deliverables against the plan, DIRECTLY FIX anything substandard, then run the probe end-to-end to prove it works.

## Context
Repo: C:\Users\Yams\Documents\Arc Power (Electron OC tool for Intel Arc; pipeline per AGENTS.md). Read `plan.md` (esp. §4a "M0 results" and the M0 milestone in §9) and `docs/igcl-integration.md` first. The M0 deliverable is `tools/probe/` (Node 24 + koffi FFI probe: igcl.mjs — DLL discovery + koffi bindings for the native IGCL runtime `IntelControlLib.dll` in the DriverStore; probe.mjs — the probe sequence). Machine has the real A770, driver 32.0.101.8861.

## What to review
1. Correctness of the koffi struct definitions vs the official IGCL headers (repo: github.com/intel/drivers.gpu.control-library, include/ folder — download the headers if needed to double-check layouts, sizes, enums).
2. Safety: the probe must never change GPU state — no-op applies only (set = current value), waiver is allowed (dev machine), reset only if a value actually changed, and the "changed" detection must be reliable.
3. Code quality: error handling (every ctl call's result checked and described), DLL discovery robustness (DriverStore re-scan; multiple iigd_dch_d.inf_amd64_* folders; graceful error if not found), cleanup of handles.
4. The docs (`docs/igcl-integration.md`): load path, init args, struct mapping table, capability matrix, decision record — accurate, concise, no stale claims.
5. Any deviation from plan §4a findings.

## Fix policy
- Fix any defect directly (edit files). If you find something that changes the documented facts, update BOTH the docs and the probe.
- Do NOT add new probe functionality beyond fixing defects (no scope creep). Do NOT commit (no git commits).
- Keep the JSON outputs in tools/probe/out/ up to date after your final run.

## Verification (must do, in order)
1. `npm test` if a test script exists (probably not yet — skip silently if absent).
2. Run the probe end-to-end: `node probe.mjs` from tools/probe/ — must complete green (all checkpoints: init, enumerate, capabilities, fans, waiver, no-op round trips, telemetry, close).
3. Verify the JSON outputs in out/ were rewritten and are consistent.
4. Confirm no GPU state was left changed (probe's own report must say so).

## Report back
- What you fixed (each item: file + issue + fix).
- Final probe run result summary (key lines).
- Any remaining risks for M1.
- Confirmation the GPU state was untouched.
