# Findings — M0 final review (step 5, round 1)

Source: step-5 reviewer verdict `VERDICT: CHANGES REQUIRED` (2026-08-05).
You are the FIXER: fix ALL findings below, add a regression test where
sensible, then run `node probe.mjs` end-to-end in `tools/probe/` so the
`out/*.json` artifacts are regenerated and consistent. Do NOT commit.

Reference files: `tools/probe/igcl.mjs`, `tools/probe/probe.mjs`,
`tools/probe/out/*.json`, `docs/igcl-integration.md`, `plan.md` §4a.

---

## F1 [STRUCTURAL] — V1 vs V2 power/voltage unit semantics must be pinned; fix labels + docs

- `probe.mjs` labels both round trips `powerLimit(V1, mW)` and `powerLimit(V2, mW)`.
  Official header: V1 `ctlOverclockPowerLimitGet/Set` is hardcoded **mW**;
  V2 is in `ctl_oc_properties_t::powerLimit::units` (W on this A770).
  Evidence: `noop.json` V1 readback 252000 (mW), V2 readback 252 (W).
  Same for voltage: V1 `ctlOverclockGpuVoltageOffsetGet` = mV hardcoded;
  V2 `GpuMaxVoltageOffsetGetV2` follows capability units (V).
- Fix:
  1. Relabel the probe's V1/V2 round-trip lines with the correct units
     (e.g. `powerLimit(V1, mW)` / `powerLimit(V2, W)`; voltage similarly).
  2. Add a short note in `docs/igcl-integration.md` (near the capability
     matrix / no-op section) pinning the per-API unit contract: "V1 power
     get/set is fixed mW (observed 252000), V1 voltage fixed mV; V2 get/set
     uses `ctl_oc_properties_t` units (W/V on this A770, observed 252/0.234);
     M1 should use V2 + capability-unit conversion."
  3. Correct any doc sentence that over-generalizes "this A770 reports
     power in watts / voltage in volts" — true for the capability field and
     V2 only.

## F2 [MINOR] — CTL_RESULT table missing error codes → outputs print "UNKNOWN"

- `igcl.mjs` result table omits several codes; VF-curve reads print
  `UNKNOWN (0x40000012)` in `a770-capabilities.json` while docs cite
  `CTL_RESULT_ERROR_DATA_READ`.
- Fix: add at least: `ERROR_DATA_READ 0x40000012`, `ERROR_DATA_WRITE 0x40000013`,
  `ERROR_INVALID_NULL_HANDLE 0x4000000d`, `ERROR_NOT_IMPLEMENTED 0x40000015`,
  `ERROR_INVALID_OPERATION_TYPE 0x4000001a`, `ERROR_INVALID_ENUMERATION 0x40000022`,
  `ERROR_LOAD 0x40000026`, `ERROR_NOT_AVAILABLE 0x40000007`, `ERROR_UNKNOWN 0x4000FFFF`
  (verify against the official `ctl_result_t` enum). Re-run so artifacts show names.

## F3 [MINOR] — "changed" detection blind edge: set-success + read-back-failure skips reset

- `probe.mjs`: `changed` flips only when `g2.result === SUCCESS && !equal(...)`.
  If a Set changed a value and the follow-up Get failed, `changed` stays
  false and Step 10 would not call `ctlOverclockResetToDefault`.
- Fix: also set `changed = true` when `setResult === SUCCESS && g2.result !== SUCCESS`
  (conservative), and log that case explicitly in Step 10.

## F4 [MINOR] — `devCount == 0` not guarded (empty success)

- `probe.mjs`: if `ctlEnumerateDevices` returns 0 devices, outputs would be
  written with `devices: []` and exit 0.
- Fix: after the count call, abort with a descriptive error if `devCount <= 0`.

## F5 [MINOR] — `activeDriverVersion()` "last Intel block" heuristic fragile on multi-GPU

- `igcl.mjs` picks the last display-class subkey with Intel `DriverDesc`;
  on iGPU+dGPU boxes this can select the iGPU driver, then fall back to
  newest-mtime (the staged-package trap).
- Fix: prefer the discrete-device block — e.g. cross-check the block's
  `DeviceID` (or the `MatchingDeviceId`) against the enumerated Arc PCI ID
  (8086:56A0-class), or prefer the non-integrated block; keep mtime as last resort.

## F6 [MINOR] — docs "re-run 2026-08-05" vs artifacts stamped 2026-08-04T22:13Z

- `docs/igcl-integration.md` says the probe was re-run 2026-08-05 after
  fixes; artifacts say 2026-08-04T22:13Z (UTC). Only consistent if local
  time is ≥1 h ahead of UTC — confirm and, after your fix run, make sure
  the regenerated artifacts and the docs' date statement agree.

## F7 [MINOR] — docs telemetry power figure stale

- `docs §9` cites "≈39 W (39.2 W / 39.4 W across runs)"; latest
  `run-summary.json` shows 39.7 W. Update after your run (use the actual value).

## F8 [MINOR] — `loadIgcl` binds every export eagerly; missing symbol kills whole module

- `igcl.mjs` calls `lib.func(...)` for all exports unconditionally; a
  driver runtime without a V2/VRAM/VF symbol would throw and break
  enumeration/telemetry too.
- Fix: wrap each bind (at least the newer V2/VRAM/VF ones) in try/catch,
  record `unavailable: <name>` on the returned object so M1 can degrade
  per-capability instead of failing hard.

## F9 [NIT] — stale size comment on `ctl_fan_properties_t`

- `igcl.mjs` comment says "28 bytes, align 4"; actual size is 24 (asserted
  elsewhere). Fix the comment.

## F10 [NIT] — docs fallback list omits one real fallback

- Docs list fallback order as env → System32 `ControlLib.dll` → IGS dir,
  but code also tries `C:\Windows\System32\IntelControlLib.dll` before the
  IGS dir. Add that entry to the doc list.

## F11 [NIT] — §9 "Supported items (13/25)" then lists 14 names

- Phrase as "13 of the 25 item fields, plus `fanSpeed[0]`" (or otherwise
  make the count unambiguous).

## F12 [NIT] — redundant `handle: undefined` mapping

- `probe.mjs` re-strips `handle` via `{ ...d, handle: undefined }` although
  it was already deleted earlier. Drop the duplicate.

---

## Verification required after fixing (in order)
1. `node probe.mjs` from `tools/probe/` — full green run (init, enumerate,
   capabilities, fans, waiver, no-op round trips, telemetry, close).
2. All five `out/*.json` regenerated and consistent (device found,
   `changed: false`, waiver ok, telemetry 3 samples, power derived).
3. Confirm no GPU state left changed (probe's own report must say so).
4. Regression tests: F1/F3 — add a tiny unit test if the probe code is
   factored to allow it; otherwise assert the labels/logic directly in the
   probe run output. (No test framework exists yet — do not add one; the
   probe run IS the test for this milestone.)

## Report back
- Per finding: what you changed (file + fix).
- Final probe run summary (key lines) + new derived power value.
- Confirmation GPU state untouched.
