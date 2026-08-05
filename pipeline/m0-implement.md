You are the M0 implementer for Arc Power: an Electron overclocking tool for Intel Arc GPUs. M0 is a RESEARCH + PROBE milestone — you write a small Node.js probe script and documentation. There is NO app UI yet. Read `plan.md` in the repo root first (sections 2, 4, M0).

## Milestone goal (from plan.md M0)
Locate the native IGCL (Intel Graphics Control Library) runtime DLL on this machine, load it from Node via koffi, and prove on the real Intel Arc A770 (present in this machine) that we can: init the API (with Level Zero flag), enumerate devices, read the full overclocking capability matrix, read fan properties/config, read power telemetry, and do a SAFE no-op apply + read-back round trip.

## Environment (already set up)
- Windows 11 (win32), PowerShell 5.1; Node 24 + npm 11 + git installed and on PATH (refresh PATH in your shell if needed).
- GPU: Intel Arc A770, driver 32.0.101.8861. Intel Graphics Software 26.18.2353.2 installed at "C:\Program Files\Intel\Intel Graphics Software" (contains IntelGraphicsSoftware.Wrapper.IGCL.dll, a .NET wrapper proving the native IGCL runtime exists here). IGS service running. .NET 10 runtime installed (only relevant for the sidecar fallback — do NOT build the sidecar in M0).
- No C++ toolchain — koffi is the intended FFI (npm package, win32-x64 prebuilds, no compiler needed).

## IGCL facts (already verified against the official spec — do not re-litigate)
- Docs: https://intel.github.io/drivers.gpu.control-library/ — Control API section. Headers + samples: https://github.com/intel/drivers.gpu.control-library (include/ folder has igcl_api.h etc. — DOWNLOAD the actual headers and base your struct definitions on them, don't guess from the doc page).
- Binaries ship with the Intel Graphics driver package; the exact DLL name/path is what you must find.
- Key calls: ctlInit/ctlClose; device enumeration (ctlDeviceGet); ctlOverclockGetProperties → ctl_oc_properties_t (per-control ctl_oc_control_info_t {bSupported, bRelative, units, min, max, step, Default, reference}); ctlOverclockWaiverSet (required before OC setters); ctlOverclockGpuFrequencyOffsetGet/Set, GpuVoltageOffsetGet/Set, PowerLimitGet/Set, TemperatureLimitGet/Set, VramFrequencyOffsetGet/Set; ctlOverclockResetToDefault; fan: ctlEnumFans, ctlFanGetProperties, ctlFanGetConfig, ctlFanGetState; telemetry: ctlPowerTelemetryGet (50 ms rate limit) → ctl_power_telemetry_t.
- ctlInit needs CTL_INIT_FLAG_USE_LEVEL_ZERO for telemetry/perf APIs (Level Zero loader `ze_loader.dll` must be loadable — search the machine if you hit CTL_RESULT_ERROR_ZE_LOADER). 64-bit only (Node is x64, fine).
- Error codes are enums in ctl_result_t (waiver not set, out of range, locked mode, reset required, etc.).

## Tasks
1. **Find the DLL.** Search: "C:\Windows\System32", "C:\Windows\SysWOW64", the DriverStore ("C:\Windows\System32\DriverStore\FileRepository", esp. igfx/iigd/igdlh-family folders), "C:\Program Files\Intel\Intel Graphics Software", and the whole driver package dirs for candidate names: igcl*.dll, libigcl*.dll, ze_loader.dll, igd*.dll. Also inspect IntelGraphicsSoftware.Wrapper.IGCL.dll's imports (PowerShell can read PE imports via LoadLibrary+GetProcAddress probing or `dumpbin` if available; otherwise use the search + the IGCL repo README/Samples to infer the binary name). Document the exact DLL path(s) you find and any dependency DLLs needed.
2. **Create the probe project**: `tools/probe/` with `package.json` (type: module), koffi, and `probe.mjs` (plus small helper modules if useful). Define the IGCL structs from the official headers.
3. **Probe sequence** (all against the real A770):
   a. ctlInit with Level Zero flag; report result + whether Level Zero resolved (locate ze_loader.dll if not).
   b. Enumerate device adapters; print name/type.
   c. ctlOverclockGetProperties → dump EVERY control's bSupported, units, min/max/step/default into a JSON file `tools/probe/out/a770-capabilities.json`.
   d. Fan: enumerate fans, ctlFanGetProperties, ctlFanGetConfig (mode + fixed speed + speed table), ctlFanGetState (RPM + %).
   e. ctlOverclockWaiverSet (allowed in this probe — it is the developer's own machine; the "never auto-accept" rule applies to product code only).
   f. NO-OP APPLY: for each supported control, read its current value, then set it to that SAME value (no behavior change), then read back and confirm equality. For power limit set in mW per the units field. If a no-op set errors, record the error code.
   g. ctlPowerTelemetryGet: sample 3 times (with ≥50 ms gap), dump all fields present.
   h. ctlOverclockResetToDefault at the end ONLY if you actually changed any value; otherwise skip. Never leave changed state.
4. **Write docs/igcl-integration.md**: exact DLL load path + init args (with the application UID you invented), full struct mapping table (C struct → koffi layout → note any padding/size traps you hit), the capability matrix for this A770 (from the JSON dump), fan + telemetry findings, Level Zero notes, and the koffi-vs-sidecar decision (default: koffi — recommend confirming it based on what you saw; sidecar only if you hit ABI pain you couldn't resolve quickly).
5. **Checkpoints** (STOP and verify at each — run the probe, fix, then continue):
   - C1: DLL located + binding module loads it and ctlInit succeeds (report result).
   - C2: capabilities + fan config dump complete on the A770 (JSON file written).
   - C3: waiver + no-op apply round trip + telemetry sampling complete; docs written; `node probe.mjs` runs end-to-end green.

## Safety rules (hard)
- NEVER apply a value different from the device's current value. No-op applies only. Your probe must not change the user's OC state.
- Do not modify anything outside tools/probe/ and docs/. Do not touch the installed IGS/driver files. Do not commit (no git commits).
- If a step fails, investigate (search files, read docs), fix, and proceed; log concise findings in the docs.

## Deliverables (report back in your final message)
- Exact IGCL DLL path(s) + any dependency DLLs found.
- ctlInit result incl. Level Zero status.
- The A770 capability matrix (condensed: which controls are bSupported + their ranges).
- Fan config summary + telemetry fields observed.
- No-op apply results (per control ok/error).
- koffi-vs-sidecar decision + one-line justification.
- Any open risks for M1.
