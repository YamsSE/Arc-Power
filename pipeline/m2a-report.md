# M2a Milestone Report — Arc Power UI core

Status: IMPLEMENTED (step-4 review gate next). Report written by host lane because the
implementer's run was interrupted twice (first at the checkpoint-4 boundary, then the resumed
session hung on a provider step with `reason: "unknown"` after the real-device diagnosis was
complete). All verification in this report was executed and logged by the implementer session
before the hang; the V1-vs-V2 diagnostic was completed by the host lane.

## File tree (M2a additions)

```
src/renderer/                    TypeScript renderer (esbuild bundle -> src/renderer/out/app.js)
  index.html                     loads out/app.js + styles
  styles.css                     design-system tokens (dark, custom properties) + components
  app.ts                         entry: router + page mount
  ipc.ts                         typed wrapper over window.arcPower (preload bridge)
  arcpower.d.ts                  global type declaration for the bridge
  types.ts                       renderer-side copies of the backend JSDoc typedefs
  dom.ts                         tiny DOM helpers (framework-free)
  router.ts                      hash router (Dashboard/Overclocking/Fan/...) + Store class (state cache)
  pure/                          framework-free logic (unit-tested)
    slider.ts  presets.ts  curve.ts  errors.ts  settings.ts  waiver.ts
  components/
    header.ts  toast.ts  waiver-dialog.ts
  pages/
    dashboard.ts  overclocking.ts  fan.ts  placeholder.ts
src/preload.cjs                  contextBridge: validated invoke wrappers + telemetry events
src/main/ipc.js                  ipcMain.handle whitelist + payload validation + clamping
src/main/ipc-core.js             channel names + shared validation helpers (pure, tested)
src/main/ui-verify.js            dev-only end-to-end UI check against MockBackend (--ui-verify)
src/main/main.js                 window now loads the real renderer; --headless/--ui-verify modes
tools/validate/m2a-apply.js      dev script: apply 200 W -> read-back -> restore (mock + real)
tools/validate/m2a-diag.js       dev script: multi-control apply diagnostics (real device)
tools/validate/m2a-v1diag.js     dev script: V1(mW) vs V2(W) power-limit comparison (real device)
test/renderer/*.test.ts          6 pure-module test files (vitest)
test/ipc-core.test.js            payload validation + no-auto-waiver product-path tests
```

## Verification

- `npm test` — **187/187 pass** (112 M1 baseline + 75 new: 6 renderer pure modules, ipc
  validation, no-auto-waiver product-path test, mock fan + N1 regression, ui-verify fixtures).
- `npx tsc --noEmit` — exit 0. `npm run build:renderer` — clean (esbuild, ~10 ms).
- `npm run smoke:mock` — SMOKE OK, reset NOT called, state untouched.
- `npm run smoke` (real A770, no-op only) — SMOKE OK, all 4 controls round-trip, no value
  changed; device untouched (verified twice: before/after state identical).
- `--ui-verify` (mock, canControl=true): 4 control cards, slider snap, waiver dialog shown
  before first apply (Cancel aborts without applying), accept -> apply -> toast -> read-back
  refresh, waiver persisted (no second dialog), reset to default, fan editor drag/remove/add.
- `--ui-verify` with `RID_MOCK_FAN_READONLY=1` (A770 fan fixture): fan card read-only — no
  draggable dots, no Apply button, read-only note shown, mode + curve + RPM rendered.

## Real-device cross-validation — ENVIRONMENTAL BLOCKER FOUND (power/temp limits)

The M2a acceptance criterion "set power limit in Arc Power -> value appears in IGS" **cannot
be demonstrated on this machine while Intel Graphics Software is running**:

- `gpuFreqOffset` (100 MHz): **sticks** — read-back 100 immediately and after 1.5 s. OC
  offsets work through IGCL on this card.
- `powerLimit` (200/230 W) and `tempLimit` (85 C): set returns **SUCCESS** but read-back
  stays 252/90 immediately and after 1.5 s. Reproduced for both V2 (W, capability units) and
  V1 (mW, fixed) — so it is NOT a unit/API-version quirk.
- `IntelGraphicsSoftwareService` is Running and the IGS app processes are active; the driver
  silently reverts power/thermal-limit writes from other apps (matches the M1 open-risk note
  "IGS is actively changing OC state between runs").
- The backend is behaving correctly: it verifies by read-back and reports `io-failed`
  ("read-back 252 != requested 200") instead of claiming success. The UI maps that to an
  error toast on the failing control.
- All diagnostic scripts restore prior values and verify (final state 210 W / 90 C / offset
  restored — verified by read-back after every run).

User action options (next session): (a) accept the documented limitation on this machine;
(b) test with `IntelGraphicsSoftwareService` stopped (reversible; confirms the culprit);
(c) use gpuFreqOffset as the visual IGS cross-check for this milestone (it works).

## Deviations from plan §9 M2a

1. Acceptance "set power limit -> appears in IGS" is blocked on real hardware (above);
   everything else in the acceptance (clamps enforced, waiver flow, reset) is verified.
2. N1 (fan table numPoints guard) + N2 (FAN_UNITS_PERCENT constant) from the M1 verify round
   were folded in and fixed with regression tests, per triage.
3. Monitoring/Profiles/Tweaks pages are placeholders (as planned; M2b/M3).
4. `--ui-verify` dev mode added for scripted end-to-end UI checks (mock-only, never hardware).

## Open risks for M2b

- Power/temp limit applies may never work while IGS is running (product implication: the UI
  must surface `io-failed` clearly — it does; and M2b profiles/apply-on-startup must handle
  partial-apply failure with toasts, already planned).
- Telemetry power derivation and graphs depend on TelemetryService streaming — verify cadence
  with the real device before building the graphs.
- PresentMon FPS capture is new FFI territory (PresentMonAPI2.dll) — fixture-buffer tests
  first, live capture checkpoint on the A770.
