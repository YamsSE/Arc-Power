# Findings — M0 step-4 verification (round 2)

Source: step-4 reviewer (VERDICT: APPROVED, non-structural leftovers for triage).
You are the FIXER: fix all findings below in `tools/probe/`, then run
`node --check` on both modules and `node probe.mjs` end-to-end so `out/*.json`
are regenerated and consistent. Do NOT commit. No test framework exists — the
probe run is the test.

Reference: `tools/probe/probe.mjs`, `tools/probe/igcl.mjs`.

---

1. **[MINOR]** `probe.mjs` gpuLock block (~line 322): only the Get symbol is
   availability-checked. If a runtime had `ctlOverclockGpuLockGet` but not
   `ctlOverclockGpuLockSet`, the Set call would throw and kill the whole
   probe instead of degrading. Fix: include
   `typeof lib.ctlOverclockGpuLockSet !== 'function'` in the guard (record a
   `symbol unavailable in runtime (degraded)` entry like the other guards do).

2. **[NIT]** `igcl.mjs` `findIgclDll` fallback comment (~lines 337-343) omits
   `C:\Windows\System32\IntelControlLib.dll` that the code actually tries
   before the IGS dir. Fix the comment to match the code.

3. **[NIT]** `probe.mjs` (~lines 344-346): the "no active lock (0,0=dynamic);
   set skipped by safety rule" message also fires when `GpuLockGet` returned
   an error. Fix: when the Get result is not SUCCESS, log the actual
   result (`describeResult`) instead of claiming no active lock.

4. **[NIT]** `probe.mjs` gpuLock / VF-curve blocks (~lines 325-343, 366-383):
   else-branch bodies are indented at the `if` level; braces are balanced but
   readability is poor. Fix: re-indent the block bodies properly.

## Verification after fixing (in order)
1. `node --check igcl.mjs` and `node --check probe.mjs` pass.
2. `node probe.mjs` full green run; all five `out/*.json` regenerated and
   consistent (`changed: false`, waiver ok, 3 telemetry samples).
3. Confirm GPU state untouched (probe report must say so).

## Report back
- Per finding: what you changed.
- Final probe run key lines.
- Confirmation GPU state untouched.
