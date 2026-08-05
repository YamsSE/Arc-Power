# Findings — M1 step-4 review (round 1)

Reviewer verification performed (read-only):
- `npm test` → 112/112 pass.
- `npm run smoke:mock` → SMOKE OK, no state changes, reset NOT called.
- Vendored `igcl-bindings.js` diffed against `tools/probe/igcl.mjs`: all 17 structs
  identical, all size assertions equal, `decodeItem` identical.
- Probe artifacts checked: `timeStamp`/`gpuEnergyCounter` are DOUBLE on the real
  driver (no string/decode issue in the telemetry path); `vramReadBandwidthCounter`
  is UINT64 but is not mapped into `RawTelemetrySample`.
- Executed a throwaway harness (temp dir, no repo edits) exercising the fan apply
  path with `canControl=true` — reproduced the F1 ReferenceError.

---

## F1 [BLOCKER] — `CTL_FAN_SPEED_UNITS` not imported → ReferenceError in the fan apply path

`src/main/backend/igcl-backend.js:618` uses `CTL_FAN_SPEED_UNITS.PERCENT` inside the
`pct()` helper, but the import at `igcl-backend.js:21-24` does not include
`CTL_FAN_SPEED_UNITS` (it is exported from `igcl-bindings.js:95`).

Proven by execution: applying `{ fixedFanPct: 30 }` (or any fanCurve) on a device
with `canControl=true` throws `ReferenceError: CTL_FAN_SPEED_UNITS is not defined`.
Masked on the A770 because `applyFan` returns before line 618 when
`canControl=false` (line 592-595), and no test exercises the `canControl=true`
fan path — which is exactly why 112/112 stayed green. This is the entire fan
control path for any future `canControl=true` card (and M2a's mock).

Suggested fix:
1. Add `CTL_FAN_SPEED_UNITS` to the import list at `igcl-backend.js:21-24`.
2. Regression test: in `test/igcl-backend.test.js`, build the fake lib with
   `{ fanCanControl: true }` and assert `applySettings(0, { fixedFanPct: 30 })`
   and `applySettings(0, { fanCurve: [...] })` return `ok:true` without throwing
   (the fake lib already accepts `opts.fanCanControl`).

## F2 [STRUCTURAL] — Fan (and VF-curve) applies claim `readBackEqual: true` without any read-back

`igcl-backend.js:640` (fanCurve), `:656` (fixedFanPct), `:677` (fanMode auto),
`:707` (vfCurve) mark `{ ok: true, readBackEqual: true }` unconditionally after a
SUCCESS return from the setter. Plan §5 (`plan.md:186`) requires "every apply is
followed by read-back verification", and the `ApplyResult` contract
(`backend.interface.js:62-66`) implies `perControl.ok` reflects verification. The
OC scalar path does set→get→compare (`igcl-backend.js:539-551`); the fan path does
not, so a driver that silently normalizes/ignores the table or fixed speed would
report success. Not exercised on the A770 (`canControl=false`), but this is the
whole fan-control path on `canControl=true` devices.

Suggested fix:
- After `ctlFanSetSpeedTableMode` / `ctlFanSetFixedSpeedMode` / `ctlFanSetDefaultMode`,
  call `ctlFanGetConfig` and verify `mode` matches the requested canonical mode
  (and the table points / fixed speed within tolerance when units are PERCENT);
  mark `ok:false` with a message on mismatch.
- After `ctlOverclockWriteCustomVFCurve`, read back via `ctlOverclockReadVFCurve`
  and compare points.
- Regression tests: fake lib whose `ctlFanGetConfig` returns a different mode after
  set → assert the control reports `ok:false`; same for the curve table.

## F3 [MINOR] — `applySettings` third `opts` param missing from the JSDoc interface

`backend.interface.js:159` declares `applySettings(deviceId: number, s: Settings)`
with no third parameter, but both implementations take it
(`igcl-backend.js:493`, `mock-backend.js:113`) and the smoke caller uses it
(`smoke.js:98`, `{ snapToStep: false }`).

Suggested fix: update the JSDoc to
`applySettings(deviceId: number, s: Settings, opts?: { snapToStep?: boolean }): Promise<ApplyResult>`
and document: default `true` (product applies snap to the capability step);
`false` reserved for the smoke no-op round trip so an off-grid current value
(e.g. the A770's 48.3 MHz) is written back exactly.

## F4 [MINOR] — `Capabilities.fan.modes` uses IGCL names, not the canonical fanMode vocabulary

`igcl-backend.js:342-344` maps `supportedModes` bits to lowercased IGCL names
(`'default'`, `'fixed'`, `'table'`), while the canonical fanMode vocabulary is
`'auto' | 'curve' | 'fixed'` (`backend.interface.js:27`, plan §6). The mock only
ever reports `['fixed']`, so the mismatch is invisible today; a UI consumer cannot
compare `fan.modes` against `fanMode` values without a translation table.

Suggested fix: map through the same table as `FAN_MODE_CANONICAL`
(`igcl-backend.js:31`): DEFAULT→`'auto'`, FIXED→`'fixed'`, TABLE→`'curve'`, so
`caps.fan.modes` and `DeviceState.fanMode` share one vocabulary. Add an assertion
to the existing caps test (`test/igcl-backend.test.js:236`).

## F5 [NIT] — canonical temperature unit string: `'C'` vs `'°C'`

`_canonicalUnitName` (`igcl-backend.js:362`) and `canonicalUnit` (`units.js:23`)
return `'C'`; the pinned convention header (`backend.interface.js:10-11`) and plan
§6 say `°C`. All consumers agree on `'C'` (mock fixture, tests) — no behavior
impact. Pick one: change both implementations (and mock/test expectations) to
`'°C'`, or fix the two doc mentions to `'C'`.

## F6 [NIT] — atomic write has no fsync before rename

`profile-store.js:41-46` writes the temp file and renames without fsync; after a
power loss the renamed target can be unflushed/empty. Plan (§6, `plan.md:232`)
only demands temp+rename and the crash tests (`profile-store.test.js:52-75`) cover
the mid-write case. Optional now (cheap): `fs.openSync`/`fsyncSync` the temp before
rename, or defer to M4 hardening as planned.

## F7 [NIT] — `IgclBackend.getCapabilities` returns the cached mutable object

`igcl-backend.js:268-273,351` returns the same object each call (only
`waiverAccepted` is refreshed); `MockBackend` deep-copies (`mock-backend.js:91`).
A consumer mutating `caps.ranges`/`controls` would poison later reads.
Suggested fix: return a `structuredClone` of the cached caps (like the mock) or
`Object.freeze` it.

---

## Test-coverage notes (prompt item 6)

- Struct marshalling fixtures: pinned well — sizes, offsets (`psu@408`,
  `fanSpeed@688`), init args, capability round-trip from `a770-capabilities.json`,
  UINT64 re-decode, fan structs (`bindings.test.js`).
- No-op round trips: covered for scalars (`igcl-backend.test.js:274-282`,
  `mock-backend.test.js:47-62`) and the smoke runner (`smoke.test.js:16-51`),
  including `snapToStep:false` off-grid preservation (`igcl-backend.test.js:388-400`).
- Atomic-write crash simulation: covered (`profile-store.test.js:52-75`).
- Migration fixtures: covered (`migrations.test.js` v0→v1, refusal, malformed,
  no-mutation; `profile-store.test.js:77-109`).
- Waiver never auto-accepted in product construction: covered
  (`igcl-backend.test.js:332-339` asserts `calls.waiver === 0` without the flag).
- **Gap:** no test exercises the `canControl=true` fan apply path (F1) and no fan
  read-back-verification test exists (F2) — both should ship with the respective
  fixes as regression tests.
