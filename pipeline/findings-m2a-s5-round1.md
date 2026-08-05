# M2a step-5 final review — round 1 findings

Reviewer: step-5 final reviewer (findings only; no edits). Date: 2026-08-05.

Verification run (all green):
- `npm test` — 210/210 pass
- `npx tsc --noEmit` — exit 0
- `npm run build:renderer` — clean
- `npm run smoke:mock` — SMOKE OK, reset NOT called
- `--ui-verify` (mock, canControl=true) — full pass incl. waiver show/cancel/accept, no-second-dialog, reset, fan editor clamp, mapped error toast
- `--ui-verify` + RID_MOCK_FAN_READONLY=1 — read-only fan path pass
- `--ui-verify` + RID_MOCK_OFFGRID_FREQ_MHZ=48.3 — off-grid readout pass
- `electron . --mock` brief run — healthy
- `electron .` (real backend, read-only boot) — health igclLoaded=true, levelZeroOk=true, A770 driver 0x002000000065229d

## FINDINGS

### 1. [STRUCTURAL] Persisted waiver acceptance is written but never read back — the waiver dialog re-appears on every app launch
- `src/main/ipc-core.js:186-188` persists `waiverAccepted: true` into settings.json on accept.
- The backend keeps the waiver only in process memory: `_waiverAccepted` is initialized empty (`src/main/backend/igcl-backend.js:68`) and only ever written by `setWaiverAccepted` (`igcl-backend.js:845`); `getCapabilities` returns `this._waiverAccepted.get(deviceId) ?? false` (`igcl-backend.js:278`).
- `store.loadSettings()` is never called outside `waiver-accept` (grep confirms only `ipc-core.js:186`), and `src/main/main.js` does no boot-time seeding.
- The renderer's dialog gate reads only `caps.waiverAccepted` (`src/renderer/components/waiver-dialog.ts:55`, `src/renderer/pages/overclocking.ts:150`, `src/renderer/pages/fan.ts:326`), so at every fresh launch the dialog re-shows despite the persisted acceptance. The settings.json write is dead weight, and M2b's apply-on-startup gate (which reads settings.json) would disagree with the dialog state.
- Suggested fix: at boot, read `store.loadSettings()` and seed the in-memory flag with a non-driver backend method, e.g. `backend.restoreWaiverState(deviceId, accepted)` on both IgclBackend and MockBackend that sets only `_waiverAccepted` (never calls `ctlOverclockWaiverSet` — no implicit acceptance), called from `main.js` after `backend.init()` for each device. Alternatively merge persisted state in the `get-capabilities` handler. Add a regression test: seeded boot → `getCapabilities().waiverAccepted === true`.

### 2. [STRUCTURAL] Fan value clamping/validation exists in MockBackend but not in IgclBackend — the clamp-in-main layer is missing for fan controls, and mock↔real drift
- `src/main/backend/igcl-backend.js:630` — `pct()` only `Math.round`s (no 0..100 clamp); the curve table (`igcl-backend.js:689-701`) does not clamp `speedPct`, does not clamp temps, does not sort, and does not enforce strictly ascending temps before `ctlFanSetSpeedTableMode`; `fixedFanPct` is likewise unclamped (`igcl-backend.js:721`).
- `sanitizeSettings` (`src/main/ipc-core.js:52-91`) only checks finiteness; `clampSettings` (`ipc-core.js:102-112`) has no ranges for `fixedFanPct`/`fanCurve`, so fan values pass through the main-side gate unclamped.
- MockBackend clamps 0..100, sorts, and bumps duplicate temps (`src/main/backend/mock-backend.js:218-224, 237`) — the two backends accept different payloads.
- Unreachable on the A770 (canControl=false) but this is exactly the layer plan §5 / item 3 requires, and it becomes live on any canControl=true device (Battlemage, future drivers). IGCL requires an ascending table.
- Suggested fix: in `IgclBackend.applyFan`, clamp `speedPct` to 0..100 (round), clamp point count to `maxCurvePoints` (already done), sort by temp and bump duplicates to strictly ascending (mirror `mock-backend.js:218-224` / `pure/curve.ts enforceAscending`) before building the table. Add a parity regression test applying the same fan payload to mock and igcl (fixture lib) and asserting identical stored state / read-back.

### 3. [MINOR] resetToDefaults has no read-back verification (unlike every apply)
- `src/main/ipc-core.js:169-174` calls `backend.resetToDefaults` and returns state with no check that values actually reverted; `igcl-backend.js:821-832` throws only on non-SUCCESS.
- Given the IGS-reverts-writes environment, a reset could return "ok" while the driver still holds old values — violates "no success claims without verification" (item 4). Currently dormant: the renderer never calls `resetToDefaults` (declared only in `arcpower.d.ts:23`; the OC page's per-card "Reset to default" + Apply path is used instead), so no product path claims false success today.
- Suggested fix: verify by read-back in the reset handler (compare fresh state to capability defaults per supported control, surface `io-failed` per control on mismatch), or wire the per-card reset through `resetToDefaults`; add a regression test with a mock that ignores `resetToDefaults`.

### 4. [MINOR] Duplicated clamp/snap math between renderer and main
- `src/renderer/pure/slider.ts:15-23` (`snapToRange`) duplicates `src/main/backend/units.js:75-87` (`clampAndSnap`) — same algorithm (snap-to-step from min, float-drift guard, clamp), two copies, drift risk (item 2).
- Suggested fix: extract to a shared module imported by both (esbuild bundles it into the renderer), or add a cross-check test asserting equal outputs over a sweep of values/ranges.

### 5. [MINOR] `npm run dist` does not chain the renderer build
- `package.json:18` — `"dist": "electron-builder --win portable"` packages whatever `src/renderer/out/app.js` exists; a stale bundle can ship in the EXE (packaged-app assumption, item 5).
- Suggested fix: `"dist": "npm run build:renderer && electron-builder --win portable"`.

### 6. [MINOR] Milestone commits missing (host-lane process gap)
- `git status` shows no commits at all on `master`; every file untracked. AGENTS.md mandates an `M<ms>: <summary>` commit + push after every milestone — M1 and M2a are uncommitted and neither milestone report records a commit. `.gitignore` correctly excludes `node_modules/`, `dist/`, `out/`.
- Suggested fix: host lane commits M1 + M2a (one commit per milestone) and pushes `-u origin main`.

### 7. [NIT] Milestone report file tree inaccuracy
- `pipeline/m2a-report.md` lists `src/renderer/store.ts`, which does not exist — the store lives in `src/renderer/router.ts` (Store class, `router.ts:67-86`).

## Not findings (verified clean)
- Channel names preload ↔ ipc-core match 1:1; payloads match JSDoc/TS types; no bypasses; emit restricted to `telemetry:sample`.
- Waiver: no auto-accept in any product path; ui-verify proves Cancel aborts without applying; `allowAutoWaiver` confined to smoke/dev-script constructors.
- Fan setters gated on `canControl` in both igcl (line 604) and mock (line 184); read-only UI path verified end-to-end.
- Smoke remains no-op-only, reset only on detected change; validation scripts restore prior values (dev-only, `allowAutoWaiver` + snapToStep:false restore).
- io-failed honesty: applies verify by read-back; UI maps `io-failed` to a clear toast; M2a report documents the IGS environmental caveat.
- Dashboard live readout driven by TelemetryService via store subscription; header/mock badge correct.

## VERDICT (round 1)
VERDICT: CHANGES REQUIRED

## Round 2 closure (step-5 re-review of the fix rounds)
F1-F5, F7, G1, G2 all verified in code with regression tests (229/229 pass, tsc exit 0, build clean, smoke:mock OK, two-run ui-verify: fresh-store dialog flow + persisted-acceptance no-dialog boot seeding). Waiver rules hold: restoreWaiverState never calls the driver; product paths never auto-accept; G2 reconciliation only clears the in-memory flag. F6 (milestone commits) is host-lane and deferred as intended.
VERDICT: APPROVED
