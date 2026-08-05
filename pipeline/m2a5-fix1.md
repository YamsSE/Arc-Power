You are the step-4 FIXER in the Arc Power pipeline (fresh session). The M2a.5 reviewer approved the feature with 8 MINOR/NIT findings in `pipeline/findings-m2a5-r1.md`. Fix all 8 — each behavior-changing fix ships a regression test that fails without it.

## Context
Repo: C:\Users\Yams\Documents\R.ID Arc Power (Electron OC tool for Intel Arc; pipeline per AGENTS.md). Read `AGENTS.md`, `docs/igcl-integration.md` §8a, `pipeline/m2a5-igs-feature.md`, the findings file, and the code it cites. Baseline green: `npm test` 260/260, `npx tsc --noEmit` exit 0, `npm run build:renderer` OK, `--ui-verify` green in both RID_MOCK_IGS_RUNNING modes.

## Fix scope (findings 1–8)

1. **ipc-core.js default adapter**: `createIpcHandlers` must default `igs` to the MOCK adapter (or require injection — ipc.js always passes it) so real elevation is unreachable in tests by construction. Regression test: calling the igs channels on the default-constructed handler flips mock state and never spawns (assert via injected-failing spawn or by asserting the mock's state object type).
2. **Absolute powershell path** in `buildElevatedLaunch`: use `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` (module constant) instead of PATH-resolved `powershell.exe`. Update the string-invariant tests to pin the absolute path.
3. **Elevation error classification**: extract pure `classifyElevationError(err)` — killed/timeout, decline-stderr (match on the stderr content beyond just English `canceled by the user`: also treat exit code 1223 (ERROR_CANCELLED) and `-Verb RunAs` decline signatures as declined), code-null, non-zero-exit; unit-test all branches. Keep the spec string `elevation declined or timed out` for declines/timeouts; other failures `service command failed (exit N)`.
4. **Probe timeout**: add `timeout: 10000` to every `execFile` in igs-service.js; treat `err.killed`/timeout as the degraded state (never throw, never stall boot). Regression test with an injected execFile that never resolves/hangs (use a fake that respects the options.timeout by rejecting with {killed:true} after it).
5. **Dashboard re-render scope**: `onUpdate` should only re-render on `igsState`/`health`/`caps` changes, not on telemetry ticks. (Keep behavior identical otherwise.)
6. **ui-verify**: after the re-enable step, add `waitFor(win, '!!.status-warning')` to pin the full round trip back to warning.
7. **Enable reporting**: `enable` should report ok:false (with a clear error) when the start-type change succeeded but the best-effort `sc start` failed, since the UI state would then be inconsistent (startType=manual but not running). If you judge the current behavior correct, explain why in the report instead.
8. (NIT 8 — see the findings file tail; fix it as written there.)

## Fix policy
- No scope creep. Do NOT commit. Do NOT run real elevation or touch the real service. Mock-only verification.
- Keep every existing test green; `npm test` expected 260 + new regression tests.

## Verification (must do, in order)
1. `npm test` — all green.
2. `npx tsc --noEmit` exit 0; `npm run build:renderer` clean.
3. `npm run smoke:mock` — SMOKE OK.
4. `--ui-verify` both RID_MOCK_IGS_RUNNING modes — OK (including the new status-warning round-trip assertion).

## Report back
- Per finding: file:line changed + the regression test that pins it.
- Final `npm test` counts, typecheck/build status, ui-verify results.
- Confirmations: no real service contact, no elevation run, no commits.
