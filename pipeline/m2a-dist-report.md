# M2a Distribution Build Report

Date: 2026-08-05 05:09 local

Artifact: `dist\Arc-Power-0.1.0.exe` (83.7 MB, portable, x64, electron-builder 26.15.3, Electron 37.10.3)

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

## Note

The GPU is currently at full defaults (210 W / 0 offset / auto fan) — no value was changed by
Arc Power; the reset was external (IGS/user).
