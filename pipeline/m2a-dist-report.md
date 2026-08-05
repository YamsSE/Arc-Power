# M2a Distribution Build Report

Date: 2026-08-05 05:09 local (final verification 05:55 local)

Artifact: `dist\Arc-Power-0.1.0.exe` (83.7 MB, portable, x64, electron-builder 26.15.3, Electron 37.10.3)

## FINAL RESULT: PASS

`dist\Arc-Power-0.1.0.exe --headless` → **exit 0** (packaged smoke green on the real A770,
no value changed). The earlier failure was environmental: the A770's driver refused
freq/power/temp OC writes while OC was engaged-without-values in IGS. Once the user applied
a real value in IGS (252 W / 29.2 MHz / 0.064 V), the driver accepted all no-op round trips
and the packaged smoke passed. Dev-tree `npm run smoke` green first, packaged EXE green
second.

Checks (per AGENTS.md step 6):

1. `npm test` — 229/229 green; `npx tsc --noEmit` exit 0; `npm run smoke:mock` OK.
2. `npm run dist` — now chains `build:renderer` (F5 fix); produced `dist\Arc-Power-0.1.0.exe`.
3. **Packaged headless smoke: BLOCKED by device state, not packaging.** The packaged app
   works end-to-end through IGCL (init/discovery/caps/state all green in the packaged asar;
   koffi native module fine). The no-op apply step failed because the A770's driver state
   changed since the M2a review runs: it now reads full defaults (powerLimit 210 W, offsets
   0/0, fan auto) and the offset controls reject even same-value writes with
   `ERROR_NOT_AVAILABLE (0x40000007)`. Identical failure reproduced in the dev tree
   (`npm run smoke`) — so it is not packaging. Earlier runs (offsets 48.3 MHz, 252 W) applied
   no-ops fine. The driver/IGS reset the OC state and now refuses offset writes; this matches
   the M1/M2a "IGS interplay" risk notes.
4. Cross-check: win-unpacked `Arc Power.exe --headless` behaves identically (exit 1 at the
   same step, everything before it green) — packaging extraction + native module loading
   confirmed good.

## Action needed to re-verify the packaged smoke (user, in Intel Graphics Software)

Enable the IGS overclocking toggle (or re-enable OC in the driver), then re-run
`dist\Arc-Power-0.1.0.exe --headless` → expect exit 0. Until then, the milestone's
distribution smoke is recorded as blocked-by-environment with the packaged app otherwise
verified working. The user-facing app is unaffected: it reads state, and any failing apply
is surfaced as an `io-failed` error toast (no false success).

## Follow-up diagnostics (05:25 local, dev scripts in tools/validate/)

The user noted the OC toggle "should not be needed for our tool" (the waiver should unlock
OC). Direct probe results on the current driver state (waiver accepted, result 0x0):

| Control | V2 set | V1 set | Read-back |
|---|---|---|---|
| gpuVoltOffset | **applies** (+0.01 V / +0.02 V stick) | — | correct |
| gpuFreqOffset | SUCCESS but ignored (read-back stays 0) | SUCCESS but ignored; set 0 → ERROR_NOT_AVAILABLE | 0 |
| powerLimit | SUCCESS but ignored (210 stays 210) | SUCCESS but ignored | 210 |
| tempLimit | same-value OK; different value (85) didn't stick earlier | — | 90 |

Voltage-first ordering does not enable the frequency path. Earlier today (03:40, while IGS
had OC configured at 48.3 MHz/252 W) the same frequency set (100 MHz) DID stick — so the
driver's acceptance of freq/power/temp writes depends on external (IGS) state and flips
between runs. The waiver is NOT the gate here (it is accepted); the driver mode is.

Conclusion: our code path is proven correct (V1+V2 both tried, read-back verified, no
false success). Frequency/power/thermal writes are currently refused/ignored by the driver
in this mode; voltage offset works. This is the documented "IGS interplay" open risk from
M1/M2a, now with hard evidence.

## Resolution

With the driver mode engaged (IGS applied values), both the dev-tree and the packaged EXE
smoke pass with exit 0 and zero state changes. The environmental caveat is documented above
for future runs: if the A770 reads full defaults, OC writes may be refused until IGS has
applied a value; the app surfaces this honestly as `io-failed` toasts.

## Note

The GPU is currently at full defaults (210 W / 0 offset / auto fan) — no value was changed by
Arc Power; the reset was external (IGS/user).
