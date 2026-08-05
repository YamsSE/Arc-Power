# Findings — M1 step-4 re-review (round 2, fix-verification)

Round-1 findings F1–F7 verified against `pipeline/run-m1-fix1.log` + the changed
code. Verification run (read-only): `npm test` → 122/122 pass; `npm run smoke:mock`
→ SMOKE OK, no changes detected, reset NOT called, state untouched; no debug files
left in the repo.

## Fix-verification summary (F1–F7 addressed)

- **F1** — `CTL_FAN_SPEED_UNITS` now imported (`igcl-backend.js:22`). The fixer's
  deviation is **correct**: `CTL_FAN_SPEED_UNITS = {0:'RPM', 1:'PERCENT'}` is a
  code→name map, so `.PERCENT` is `undefined` by construction; the struct field
  needs the numeric code. `FAN_UNITS_PERCENT` (derived from the enum,
  `igcl-backend.js:35`) is written by `pct()` (`:627`) and used by the read-back
  checks (`:655`, `:669`). Regression test (`test/igcl-backend.test.js:382`)
  covers both `fixedFanPct` and `fanCurve` on `canControl=true` and would have
  caught both the ReferenceError and the undefined-units (RPM) encoding.
- **F2** — `verifyFanConfig` (`igcl-backend.js:636-675`) + VF-curve read-back
  (`:772-806`); mismatch → `{ok:false, errorCode:'io-failed', readBackEqual:false}`.
  Six regression tests (`:398,413,428,443,507,534`), all fail without the fix
  (fake setters now stateful so read-back reflects the set).
- **F3** — `applySettings(deviceId, s, opts?: { snapToStep?: boolean })` with
  default/smoke semantics documented (`backend.interface.js:159-163`).
- **F4** — `caps.fan.modes` mapped through `FAN_MODE_CANONICAL`
  (`igcl-backend.js:351-353`); regression test `0x7 → ['auto','fixed','curve']`
  (`test/igcl-backend.test.js:276`).
- **F5** — docs aligned to `'C'` (`backend.interface.js:11`, `units.js:6`).
- **F6** — `fsyncSync` before rename (`profile-store.js:46-52`); regression test
  spies `fs.fsyncSync` call count (`test/profile-store.test.js:77`).
- **F7** — `structuredClone` on cached + first-build paths (`igcl-backend.js:272-279`,
  `:360-361`); regression test for caller-mutation isolation (`:286`).

## New issues (triaged — MINOR/NIT only, no A770-path behavior change)

## N1 [MINOR] — `verifyFanConfig` reads the fan table without the numPoints ≤ 32 guard

`igcl-backend.js:653` iterates `for (let i = 0; i < cfg.speedTable.numPoints; i++)`
reading `cfg.speedTable.table[i]`, but `ctl_fan_speed_table_t.table` is a fixed
32-element array and `numPoints` is driver-reported. The sibling read-back in
`getCurrentSettings` guards `numPoints > 0 && numPoints <= 32`
(`igcl-backend.js:467`); the new code does not. A driver reporting `numPoints > 32`
would make `tp` undefined → `tp.speed` TypeError propagates out of `verifyFanConfig`
→ `applySettings` throws, instead of a controlled per-control failure.
Suggested fix: before iterating, `if (numPoints < 0 || numPoints > 32)` return
`{ ok: false, message: 'fan curve read-back has invalid point count' }` (mirror the
`getCurrentSettings` guard), plus a regression test injecting `numPoints: 40`.

## N2 [NIT] — `getCurrentSettings` fan read-back still uses the literal PERCENT code

`igcl-backend.js:475` (`tp.speed.units === 1`) and `:481`
(`cfg.speedFixed.units === 1`) predate `FAN_UNITS_PERCENT`. Functionally identical,
but the constant is now the single source of truth. Suggested fix: use
`FAN_UNITS_PERCENT` in both spots (and drop the stale `CTL_FAN_SPEED_UNITS[1]`
comment at `:481`) for consistency with the apply/verify path.

## N3 [NIT, deferred to M4] — VF-curve write passes canonical volts into u32 struct fields; new read-back surfaces the mismatch

`igcl-backend.js:767` maps `settings.vfCurve` straight into
`ctl_voltage_frequency_point_t` (`Voltage: uint32`), so a fractional canonical
voltage (e.g. 0.9 V) is truncated by koffi on write while the new read-back
(`:797`) compares against the untruncated `want.Voltage` → the apply would report
`ok:false` even on a device that applied the curve. Dead path on Alchemist
(`vfCurve` unsupported, `DATA_READ` on Get) and the whole VF-curve mapping is an
explicit M4 (Battlemage) item — the fixer's deferral note is sound. Record for M4:
pin the volts↔u32 (mV) scaling against real hardware and convert in the write +
read-back comparison; keep the current integer-fixture tests as-is for M1.

---

VERDICT: APPROVED
