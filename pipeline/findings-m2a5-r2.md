# M2a.5 IGS-service findings — round 2 (step-4 re-review of fix round 1)

Fixer report: `pipeline/run-m2a5-fix1.log`. Verification performed fresh:
`npm test` 274/274, `npx tsc --noEmit` exit 0, `npm run build:renderer` OK,
`npm run smoke:mock` OK (exit 0). (The fixer's two `--ui-verify` runs in
both modes are in the report; I re-verified everything except re-running
ui-verify here, and the changes since round 1 touch neither the mock flow
nor the UI-verify paths.)

## Fix verification (8/8 spot-checked)

1. **Default adapter = mock** — `src/main/ipc-core.js:160` (`igs = createMockIgs()`); real adapter no longer imported in ipc-core.js (product path injects via `ipc.js`/`main.js`). Regression test `test/ipc-core.test.js:362` exercises disable/enable with NO injection and asserts `{ok:true}` — fails if the default regresses to the real adapter. **Safety property holds: real elevation unreachable unless explicitly injected.**
2. **Absolute powershell path** — `src/main/igs-service.js:196` uses `${POWERSHELL_EXE}`; pinned at `test/igs-service.test.js:170`. ✓
3. **classifyElevationError** — pure, exported, `igs-service.js:212`; `runElevatedCommand` delegates (`:235`, `:237`). 7 tests cover killed/1223/English+localized decline/RunAs-elevation-required/spawn-null/other-exits. ✓ (See BLOCKER — the integration still misroutes on success.)
4. **Probe timeout** — `SC_PROBE_TIMEOUT_MS=10000` (`:30`), threaded through every `runSc` (`:119`, `:121`) with `degraded: code === null || killed` (`:129`); `getIgsServiceState` accepts injectable `{ execFile, probeTimeoutMs }` (`:141`). 3 tests incl. a hung-probe elapsed-window check. ✓
5. **Dashboard re-render scope** — `dashboardNeedsFullRender` in `pure/status.ts:71`; `dashboard.ts:188-211` full-renders only on igsState/health/caps/bootError changes and refreshes `#dash-readout` in place on ticks; `render()` resets `lastSig` (`:120`) so navigation always starts fresh. Skipped slots (`state`/`devices`/`deviceId`) only change at boot or while the OC page is active, so no stale-card regression. 3 tests. ✓
6. **ui-verify round trip** — `src/main/ui-verify.js:108` now waits for `.status-warning` after re-enable. ✓
7. **Finding 7 (enable reporting) — I AGREE with the fixer's judgment.** The spec makes `sc config start= demand` authoritative and the start/stop best-effort; `sc start` exits 1056 when the service is already running, i.e. the goal state is already reached — reporting `ok:false` there would be a false failure, mirroring why `sc stop` on a stopped service (1062) still yields ok on the disable path. The post-action state refresh (`runIgsToggle` re-reads igsState) shows the true state immediately. No change required.
8. **Log count** — corrected to 21 in the report; `*.log` is gitignored. ✓

## FINDINGS (new issues)

1. [BLOCKER] `src/main/igs-service.js:230,234` — **a successful elevated action is always reported as a failure.** `runElevatedCommand` destructures `code` from the resolved promisified-`execFile` promise, but `promisify(execFile)` resolves with `{ stdout, stderr }` and **no `code` field** (verified empirically: `resolve keys: ['stdout','stderr'] code: undefined`). So `if (code === 0)` is never true and every success falls through to `classifyElevationError({ code: undefined })`, which maps `code === null` → `ELEVATION_FAILED_MSG`. Result: on the real device, `disableIgsService()`/`enableIgsService()` genuinely run the elevated `sc config`/stop/start, but the IPC result is always `{ ok: false, error: 'elevation declined or timed out' }` — the dashboard toasts "Failed to disable IGS service — elevation declined or timed out" even when the service was successfully disabled/enabled (the card self-corrects via the post-action state refresh, so the user sees a contradictory failure toast + flipped state). The mock path is unaffected (mock adapter never calls `runElevatedCommand`). This was already latent in round 1 and survived because `runElevatedCommand`'s `execFile` is NOT injectable — round-1 finding 3's classification tests cover the pure function only, not this integration.
   Suggested fix:
   - Success path must not depend on a resolved `code`: `await execFile(POWERSHELL_EXE, [...], { windowsHide: true, timeout: timeoutMs }); return { ok: true };` (promisified execFile only resolves on exit 0; any non-zero exit rejects into the catch).
   - Make `execFile` injectable on `runElevatedCommand` the same way `getIgsServiceState` does (`{ execFile = execFile, ... }`), and add a regression test that fails without the fix: a fake exec that RESOLVES must yield `{ ok: true }`; a fake exec rejecting `{ code: 1060 }` must yield `service command failed (exit 1060)`; rejecting with `{ killed: true, code: null }` must yield `ELEVATION_FAILED_MSG`.

No other new findings. All round-1 MINOR/NIT items are confirmed fixed; nothing else introduced by the fixes.

## VERDICT

VERDICT: CHANGES REQUIRED
