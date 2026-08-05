# M2a.5 IGS-service findings — round 1 (step-4 review)

Verification performed: `npm test` 260/260 pass, `npx tsc --noEmit` exit 0,
`npm run build:renderer` OK, `npm run smoke:mock` OK (exit 0), `--ui-verify`
passes in both `RID_MOCK_IGS_RUNNING` modes (running: warning dot + note +
disable → re-enable flip; stopped: ok dot, no note, re-enable button).

No BLOCKER or STRUCTURAL findings. All items below are MINOR/NIT-level:
nothing changes architecture, data model, interfaces, or behavior on this
machine; they are hardening/triage items.

## FINDINGS

1. [MINOR] `src/main/ipc-core.js:160` — `createIpcHandlers` defaults
   `igs = createIgs()`, which instantiates the REAL service adapter inside
   unit tests: `test/ipc-core.test.js:146,163,175,185,195,206,218,265,281`
   call `createIpcHandlers` without `igs`. Today none of those tests invoke
   the igs channels, so nothing spawns — but the hard safety rule ("mock
   mode / tests never touch the service, real disable/enable only via an
   explicit injection") is guaranteed by convention, not by construction. A
   future test that happens to call `handlers['igs-service-disable']()`
   without injecting a mock would trigger a real UAC prompt.
   Fix: default to `igs = createMockIgs()` (or drop the default and require
   `igs` — `ipc.js` always passes it), so real elevation is unreachable
   unless explicitly injected.

2. [MINOR] `src/main/igs-service.js:177` — `buildElevatedLaunch` uses
   `-FilePath 'powershell.exe'` (PATH-resolved, in the non-elevated context)
   while the outer invocation and `SC_EXE` use absolute paths. PATH is not a
   trust boundary to rely on at the elevation boundary; also inconsistent
   with the module's own `POWERSHELL_EXE` constant (igs-service.js:20).
   Fix: use
   `-FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'`
   in the launch string (pinned by the existing string-invariant tests).

3. [MINOR] `src/main/igs-service.js:187-204` — `runElevatedCommand`'s error
   classification has no regression tests (only string construction is
   pinned), and the UAC-decline regex `/canceled by the user/i` only matches
   the English message: on a non-English Windows a declined UAC prompt falls
   through to `service command failed (exit 1)` instead of the spec string
   `elevation declined or timed out`. Behavior stays safe (ok:false + toast +
   post-action state refresh), but the spec's exact string is missed on
   localized systems. Also `getIgsServiceState`'s degrade paths (spawn
   failure → DEGRADED_STATE) are structurally sound but unpinned.
   Fix: extract a pure `classifyElevationError(err)` and unit-test
   killed/timeout, declined-stderr, code-null, and non-zero-exit cases;
   optionally test `getIgsServiceState` degrade by injecting a failing
   `execFile`.

4. [MINOR] `src/main/igs-service.js:105-118` — `runSc` has no timeout:
   `execFile` is called without `timeout`, and `app.ts:104` awaits the probe
   during boot, so a hung `sc.exe` would stall boot indefinitely. Local
   queries return in ms, so likelihood is low, but the fix is cheap.
   Fix: add `timeout: 10000` to the `execFile` options and treat
   `err.killed`/timeout as degraded (same DEGRADED_STATE path).

5. [NIT] `src/renderer/pages/dashboard.ts:178-182` — `onUpdate` fully
   re-renders the page on every store change, including every telemetry
   tick (store.set({latestSample}) per sample). Documented deviation,
   harmless (dashboard holds no interactive state), but it is per-tick DOM
   churn. Optionally scope the full re-render to changes of `igsState` /
   `health` / `caps` only.

6. [NIT] `src/main/ui-verify.js:101-111` — the re-enable step asserts the
   button text and the underlying state, but not that the header dot flips
   back to `.status-warning`. Add a `waitFor(win, '!!.status-warning')`
   after re-enable to pin the full round trip.

7. [NIT] `src/main/igs-service.js:153-165` — enable reports `{ok:true}` when
   `sc config start= demand` succeeds even if the best-effort `sc start`
   failed (per spec). The toast then says "IGS service enabled" while the
   immediate state refresh shows "stopped (manual)" — self-correcting within
   a second. Spec-sanctioned; no change required, noted for triage.

8. [NIT] Implementer report (`pipeline/run-m2a5-igs.log` deliverables) says
   "22 new" tests in `test/igs-service.test.js`; the file contains 21
   (21 + 6 + 4 = 31 new, 229 + 31 = 260 — the total is correct, the per-file
   count is off by one).

## VERDICT

VERDICT: APPROVED
