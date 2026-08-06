# Arc Power — Plan (v5)

Overclocking tool for Intel Arc GPUs (Alchemist A770 first, Battlemage later),
in the spirit of MSI Afterburner / AMD Adrenaline / Intel Graphics Software.

## 1. Goal and scope

A Windows desktop app (Electron) that:

- reads the installed Intel Arc GPU(s) and their overclocking capability
  (limits, ranges, supported controls) at runtime — never hardcode limits;
- applies: power limit (W), GPU voltage offset (mV), GPU frequency offset
  (MHz), temperature limit (°C), fan mode (auto / custom curve / fixed %),
  fan curve (temp → speed points) — plus, capability-gated expert
  controls: VRAM frequency offset (GT/s), VRAM voltage offset (mV),
  GPU voltage lock (VF point), custom VF curve;
- restores defaults / reset; apply-on-startup option; system tray;
- shows live telemetry as readouts and rolling graphs: GPU clock, memory
  clock, temperature, power, fan RPM/%, utilization, throttle-reason
  flags, plus FPS / frame-time via PresentMon;
- saves/loads named profiles;
- later milestone: registry hacks (MPO disable etc.) with one-click revert.

Target order: Intel Arc A770 (owned, Alchemist) first, then Battlemage
(B580-class) on the same API; per-GPU capability matrix drives what the
UI shows.

## 2. Core technical decision: Intel Graphics Control Library (IGCL)

**The overclocking backend is Intel's public, documented IGCL API**, not
reverse-engineering of the Intel Graphics Software (IGS) app transport.
Verified 2026-08-04:

- Docs: `intel.github.io/drivers.gpu.control-library` (Control API spec);
  source/headers: `github.com/intel/drivers.gpu.control-library`
  ("IGCL binaries are distributed as part of Intel Graphics driver
  package", license included in repo).
- Community proof: Shamino's Arc OC Tool
  (`skatterbencher.com/arc-oc-tool`) is a working third-party tool that
  drives exactly these functions on Arc A3/A7, standalone from IGS.
- Relevant API surface (verified in the spec):
  - `ctlInit`/`ctlClose` (init args carry an application UID, init flags;
    `CTL_INIT_FLAG_USE_LEVEL_ZERO` required for telemetry/perf/frequency);
    `ctlDeviceGet`/`ctlDeviceGetAdapter` for enumeration.
  - OC: `ctlOverclockGetProperties` → `ctl_oc_properties_t` with
    per-control `ctl_oc_control_info_t {bSupported, bRelative, units,
    min, max, step, Default, reference}` — the capability source;
    `ctlOverclockWaiverSet` (warranty waiver, required before OC
    setters); `ctlOverclockGpuFrequencyOffsetGet/Set` (MHz),
    `...GpuVoltageOffsetGet/Set`, `...GpuLockGet/Set` (VF pair),
    `...VramFrequencyOffsetGet/Set` (GT/s), `...VramVoltageOffsetGet/Set`
    (mV), `...PowerLimitGet/Set` (sustained, mW), `...TemperatureLimitGet/Set`;
    `ctlOverclockResetToDefault` (resets offsets/limits/lock, NOT fan);
    V2 variants; custom VF curve read (`STOCK`/`LIVE`)/write
    (`ctlOverclockReadVFCurve`/`WriteCustomVFCurve`).
  - Fan: `ctlEnumFans`, `ctlFanGetProperties` (canControl, supportedModes,
    maxRPM, maxPoints), `ctlFanGetConfig`, `ctlFanSetFixedSpeedMode`,
    `ctlFanSetSpeedTableMode` (temp→speed curve, ascending),
    `ctlFanSetDefaultMode`, `ctlFanGetState`.
  - Telemetry: `ctlPowerTelemetryGet` → `ctl_power_telemetry_t`
    (50 ms rate limit): gpu/vram current clock, core/mem/VR temps,
    energy counters (power derivable), activity/utilization counters,
    throttle flags (power/temp/current/voltage/utilization limited),
    fan RPM (per fan), voltages.
  - OC-specific error codes (waiver not set, value out of range, voltage
    locked mode, reset required) map 1:1 to user-facing errors.
- Constraints: telemetry/OC/fan APIs are 64-bit only (Level0 limitation)
  — Electron main process is x64, fine. Level Zero loader must be
  resolvable (`CTL_RESULT_ERROR_ZE_LOADER` if not) — verify in M0; the
  driver package ships it (IGS install includes a Level0-dependent
  wrapper), locate and document the exact DLL set in M0.

**Calling convention:** IGCL exports C functions loadable via
`LoadLibrary`+`GetProcAddress`; the Electron main process will call it
through **koffi** (pure-JS FFI, win32-x64 prebuilds, no C++ toolchain
needed), using the struct layouts from the official headers.

**Fallback:** a tiny .NET 10 sidecar (console app, P/Invoke `DllImport`
against the same IGCL exports; .NET 10 runtime already installed) behind
the same `IOCBackend` interface, if koffi struct/ABI binding proves
fragile. This also covers future driver changes. **IGS reverse
engineering is dropped** (not needed; IGCL talks to the driver directly).

## 3. Non-goals (for now)

- No kernel driver of our own; everything goes through Intel's IGCL stack.
- No bypass of the ranges Intel reports; we respect min/max/step from
  `ctl_oc_properties_t` in both backend and UI.
- No macOS/Linux support (Electron, but all backends are Windows-only).
- No automatic OC validation/stress tooling (user accepts risks; waiver
  dialog mirrors Intel's).
- No persistence inside the driver — profiles live in our app; OC state
  is reapplied by us (apply-on-startup) and verified by read-back.

## 4. Environment facts (verified on this machine, 2026-08-04)

- GPU: Intel Arc A770, driver 32.0.101.8861.
- Intel Graphics Software 26.18.2353.2 installed; its install dir
  contains `IntelGraphicsSoftware.Wrapper.IGCL.dll` (a .NET wrapper over
  the native IGCL runtime — proof the driver-adjacent IGCL runtime exists
  on this box; M0 locates the native runtime DLL, expected inside the
  driver package / DriverStore / IGS dir).
- IGS service `IntelGraphicsSoftwareService` running (not required by us;
  record any interplay in M0 — e.g., whether IGS "overclocking" toggle
  affects IGCL OC state on Alchemist).
- .NET 10 runtime (10.0.7) installed; `winget` available; git, Node, npm
  now installed (git 2.55, node 24.19, npm 11.17); no C++ toolchain
  (koffi avoids needing one). Battlemage hardware NOT available here —
  M4 validation is conditional (see M4).

## 4a. M0 results (probe on the A770, driver 32.0.101.8861 — 2026-08-04)

- **DLLs:** the runtime `IntelControlLib.dll` ("Intel Graphics Control Lib
  Runtime" v1.2.291.0) lives in the DriverStore
  (`...\DriverStore\FileRepository\iigd_dch_d.inf_amd64_*\IntelControlLib.dll`)
  and accepts the **all-zeros application UID** (same as Intel samples /
  LibreHardwareMonitor). `C:\Windows\System32\ControlLib.dll` is a
  **loader** that enforces a registered-UID whitelist — do not use it.
  The runtime imports only system DLLs; Level Zero (`ze_loader.dll`) is
  present and resolves. DriverStore folder hash changes per driver →
  re-scan at launch (probe code already does this).
- **A770 capability matrix** (units as reported — the backend/UI must be
  units-aware, do NOT assume mV/mW): gpuFrequencyOffset 0–300 MHz step 1;
  gpuVoltageOffset 0–0.234 **volts** step 0.005; powerLimit 105–252
  **watts** step 1 default 210; temperatureLimit 60–90 °C default 90.
  VRAM frequency/voltage offsets, vramMemSpeedLimit, VF curves:
  **unsupported on Alchemist** (hide in UI; keep backend paths for
  Battlemage in M4).
- **Fan:** 1 fan, `canControl=false` via IGCL, modes FIXED only,
  maxPoints 10; current config is a TABLE of 10 points
  (20 °C→20% … 90 °C→100%); state reads ~1030 RPM (1029–1036 across
  runs); % unsupported.
  → Fan page will be read-only on this card unless M1 proves otherwise
  (open question: IGS applies fan curves — possibly only via its own
  service path; verify in M1, do not block).
- **Telemetry:** 13/25 items supported (clock, temp, voltage, energy
  counters, activity counters, VRAM clock/bandwidth, fan RPM); PSU items
  unsupported; 50 ms rate limit respected; idle GPU power derived from
  energy deltas ≈ 39 W (validated method).
- **No-op applies:** all 4 supported controls × V1+V2 → get/set(same)/get
  round trips all SUCCESS; waiver accepted; no state changed; IGS service
  unaffected (ctlClose returns SUCCESS_STILL_OPEN_BY_ANOTHER_CALLER —
  expected, harmless).
- **Decision record:** koffi confirmed (struct layouts verified vs MSVC
  sizes; no ABI pain). .NET sidecar remains fallback only.

## 5. Architecture

```
┌─ Renderer (Chromium, contextIsolation, sandbox, no nodeIntegration) ─┐
│  Vanilla TS + CSS design system (dark, Adrenaline-clean)             │
│  Pages: Dashboard · Overclocking · Fan · Monitoring · Profiles ·     │
│         Tweaks (registry)  — sidebar nav                             │
│  Sliders (step-snapped) · SVG fan-curve editor · Canvas graphs       │
└──────────────▲ IPC (contextBridge, preload.js, validated channels) ─┘
┌─ Main process (Node, x64) ───────────────────────────────────────────┐
│  IOCBackend                                                          │
│    ├─ IgclBackend  (koffi FFI → native IGCL runtime DLL)   [primary]│
│    ├─ SidecarBridge (.NET 10 stdio JSON-RPC, P/Invoke IGCL) [fallback]│
│    └─ MockBackend  (tests + demo mode, deterministic samples)        │
│  TelemetryService (owns poll cadence 500ms [respects 50ms IGCL       │
│                   limit], power-from-energy derivation, ring buffer) │
  │  PresentMonClient (koffi → PresentMonAPI2.dll: FPS/frame-time)       │
  │  VramUsageClient (koffi → IDXGIAdapter3::QueryVideoMemoryInfo)      │
│  RegistryHacks (catalog + reg.exe, elevation via relaunch)           │
│  ProfileStore (JSON, schemaVersion + migrations, atomic writes)      │
│  Tray + apply-on-startup (HKCU Run key → `--apply-profile <id>`)     │
└──────────────────────────────────────────────────────────────────────┘
```

- **Telemetry ownership:** backends expose raw sample streams mapped 1:1
  from IGCL (incl. energy counters); `TelemetryService` owns poll
  cadence, power derivation, and the ring buffer. `MockBackend` emits
  deterministic sample sequences for tests.
- All numeric limits/steps/defaults come from the backend capability
  query at runtime; the UI renders exactly what the device supports and
  clamps every apply.
- Waiver flow: first time the user applies an OC value, show the
  warranty-waiver dialog; on accept, call `ctlOverclockWaiverSet`;
  never auto-accept. The apply-on-startup toggle stays disabled until
  `waiverAccepted` for the device.
- Apply-on-startup: Run key launches `ArcPower.exe --apply-profile
  <id>`; on boot-time apply failure, fall back to defaults + toast —
  never a silent partial apply.
- Safety: values are clamped to device ranges both in UI and backend;
  every apply is followed by read-back verification; reset-to-default is
  one click; explicit expert-mode reveal for lock/VF-curve/VRAM controls.

## 6. Data model

Two distinct settings-shaped types (per review round 1):

- **`Settings`** — apply intent; nullable field = "leave the current
  driver value untouched":
  `{ powerLimitW?, gpuVoltOffsetMv?, gpuFreqOffsetMhz?, tempLimitC?,
  vramFreqOffsetGts?, vramVoltOffsetMv?, gpuLock?: {voltageMv, freqMhz},
  vfCurve?: [{voltageMv, freqMhz}], fanMode?: "auto"|"curve"|"fixed",
  fanCurve?: [{t, speedPct}], fixedFanPct? }`
- **`DeviceState`** — read-back from `getCurrentSettings`; every control
  the device supports is fully resolved (never "untouched"); a field is
  null only when unsupported on that device. Same shape as `Settings`
  but with all supported controls filled; `fanCurve` uses speed in %
  normalized from the fan API (units recorded from
  `ctl_fan_properties_t`).
- `ApplyResult`: `{ ok: boolean, perControl: Record<Control,
  {ok, errorCode?, message?}> }`; `errorCode` is a fixed enum mirroring
  the IGCL OC error codes (waiver-not-set, value-out-of-range
  [per control], voltage-locked-mode, reset-required, unsupported); UI
  maps each to a toast on the failing control.
- `Capabilities` (per device, mapped from `ctl_oc_properties_t` +
  `ctl_fan_properties_t`):
  `{ oemName, deviceName, waiverAccepted, controls: { gpuFreqOffset?,
  gpuVoltOffset?, gpuLock?, vramFreqOffset?, vramVoltOffset?, powerLimit?,
  tempLimit?, vfCurve? }, ranges: Record<control, {min,max,step,default,
  units}>, fan: { canControl, modes, maxRpm, maxCurvePoints } }`
- `RawTelemetrySample` (1:1 from IGCL, nullable per field):
  `{ t, gpuClockMhz?, memClockMhz?, tempC?, memTempC?, vramTempC?,
  voltageMv?, gpuEnergyJ?, vramEnergyJ?, totalEnergyJ?, fanRpm[]?,
  utilPct?, throttle: {power?, temp?, current?, voltage?, util?} }`
- `TelemetrySample = derive(RawTelemetrySample, fps?, vramUsedMb?)`:
  adds powerW (computed from energy-counter deltas, owned by
  TelemetryService), fps/frameTimeMs (PresentMon), vramUsedMb (via
  `IDXGIAdapter3::QueryVideoMemoryInfo` through koffi — IGCL telemetry
  does not report VRAM usage).
- `Profile`: `{ id, name, createdAt, schemaVersion, settings,
  ocOnBoot: boolean }`
- `RegistryHackDef`: `{ id, name, description, enable, disable,
  requiresAdmin }` — code catalog, reversible.
- Persistence: `%APPDATA%\ArcPower\profiles.json` + `settings.json`;
  every file carries `schemaVersion`; migrations are pure functions with
  tests; never clobber unknown/newer versions (refuse with message).
  Atomic writes (temp file + rename) in M1.

## 7. Interfaces

```ts
interface IOCBackend {
  init(): Promise<void>;                       // ctlInit + Level Zero flag
  listDevices(): Promise<DeviceInfo[]>;
  getCapabilities(deviceId): Promise<Capabilities>;
  getCurrentSettings(deviceId): Promise<DeviceState>;   // read-back
  applySettings(deviceId, s: Settings): Promise<ApplyResult>; // clamped
  resetToDefaults(deviceId): Promise<void>;          // OC + fan defaults
  setWaiverAccepted(deviceId): Promise<void>;        // ctlOverclockWaiverSet
  onRawTelemetry(deviceId, cb): Unsub;               // 1:1 IGCL samples
  health(): Promise<{igclLoaded, driverVersion, levelZeroOk, error?}>;
}
```

Both real backends map 1:1 to IGCL calls; MockBackend implements the same
contract from fixture data. Wire/fixture tests pin the mapping.

## 8. UI/UX design goals (user requirement: "as clean as Adrenaline / Intel Graphics Software")

- Dark theme, design tokens via CSS custom properties; system font stack
  or Inter; generous spacing; rounded cards; subtle accent color.
- Left sidebar navigation (Dashboard, Overclocking, Fan, Monitoring,
  Profiles, Tweaks); single GPU header with name/driver/status.
- Overclocking page: one card per control — labeled slider with live
  value readout, min/max/step ticks, preset chips (e.g., stock/medium/
  max within range), Apply / Reset buttons; "Advanced" disclosure for
  expert controls (lock, VF curve, VRAM).
- Fan page: interactive SVG curve editor (draggable points, add/remove,
  point-count clamp, presets) + mode toggle (Auto / Curve / Fixed);
  current fan RPM marker on the curve.
- Monitoring page: readout grid + stacked rolling Canvas graphs
  (clock/temp/power/util/fan, fps), 30–60 s window, pause/export later.
- Status/toasts for service/driver problems and OC error codes.
- No external UI framework: vanilla TS + small component helpers keeps
  the build trivial and the surface testable.

## 9. Milestones

### M0 — IGCL validation on the A770 (research + probe; no app UI)
- Toolchain done (git, node, opencode CLI installed; repo git-initialized).
- Locate the native IGCL runtime DLL on this machine (search driver
  package / DriverStore / IGS dir; inspect `Wrapper.IGCL.dll` imports);
  document exact filename + how to load it.
- Write a small probe script (Node+koffi): `ctlInit` (with Level Zero
  flag), enumerate adapters, `ctlOverclockGetProperties` (dump the A770
  capability matrix: power/voltage/freq/vram/temp ranges), waiver flow,
  one no-op apply + read-back, `ctlFanGetProperties`/`GetConfig`,
  `ctlPowerTelemetryGet` sampling.
- Answer: does the A770 report `bSupported` for each control? Does
  Level Zero load? Does IGCL OC work while IGS is also running?
- Deliverables: `docs/igcl-integration.md` (load path, init args, full
  struct mapping, capability matrix dump, notes) + decision record on
  koffi vs sidecar (default: koffi).
- Acceptance: probe successfully reads capabilities + telemetry + fan
  config on the A770.

### M1 — Core backend (implementer run; checkpointed)
- Electron skeleton, `IOCBackend`, `IgclBackend` (koffi), MockBackend,
  TelemetryService (poll + ring buffer + power-from-energy), ProfileStore
  + migrations (atomic writes), `health()`.
- M0 carry-overs: DriverStore re-scan for `IntelControlLib.dll` at launch;
  zero-UID init; **units-aware conversions** (capability units drive
  conversion, never assume mV/mW); fan `canControl=false` handled as
  read-only with a probe: try one reversible fan-table apply + restore,
  record result, do not block; VRAM/VF-curve controls hidden when
  unsupported.
- Checkpoints (stop, build, run tests, fix reds):
  1. IGCL binding module compiles + unit-tested against recorded fixture
     buffers (struct marshalling pinned);
  2. capability fetch + apply/read-back + reset (mock + real-device no-op
     apply: set value to its own current value, verify round trip; the
     probe run must call `ctlOverclockWaiverSet` first — the
     auto-accept prohibition applies to product code, not the headless
     probe);
  3. ProfileStore + migrations tested; full `npm test` green.
- Acceptance: `npm test` green; `--headless` smoke: init, capabilities,
  no-op apply round trip, telemetry ticks, reset — on the real A770.

### M2a — UI core (implementer run; checkpointed)
- Design system; Dashboard; Overclocking page (sliders, clamps, presets,
  waiver dialog, apply/reset with per-control error toasts); Fan page
  (mode toggle + SVG curve editor); GPU header; real-device
  cross-validation.
- Checkpoints: after design system + Dashboard (build+tests); after
  Overclocking page wired to backend (build+tests + real-device apply
  cross-validated against IGS UI); after Fan page (build+tests); full
  test+build.
- Acceptance: on the real A770: set power limit in Arc Power → value appears
  in IGS; reset restores; clamps enforced; waiver flow works.

### M2b — Monitoring, profiles, tray + IGS-independent OC apply (implementer run; checkpointed)
- Monitoring page (readout grid + Canvas graphs) driven by TelemetryService; PresentMonClient (koffi → PresentMonAPI2.dll); Profiles panel (save/load/rename/delete, ocOnBoot with waiver gate); tray + apply-on-startup (`--apply-profile <id>`); error toasts.
- **UX refinements (user request):**
  - No-op applies: applying a value identical to the driver's current read-back must NOT show a success toast (silent success; error toasts unchanged).
  - Tuning/Overclocking tab made compact (denser cards, no scrolling to reach Apply).
  - Floating **Apply** button anchored bottom-left (tab side), appearing only when settings are dirty/changed; disappears when clean.
  - Remove the Electron menu bar (autoHideMenuBar) — an Alt-key shortcut can reveal it later if ever needed.
- **Dashboard redesign (user request — cleaner, less bloated):**
  - Driver version shown as `32.0.101.8861 - Jul 05, 2026` (version + date; decode the IGCL uint64 driver_version to dotted form; date from the Windows display-driver registry `DriverDate` key matched to the Arc adapter, or the DriverStore INF file date as fallback). Used in the GPU header below the card name.
  - Remove PCI ID entirely (header + status card).
  - Add Memory Clock readout next to Core Clock in the live readout.
  - OC waiver: no persistent status display — keep only a small disclaimer shown the first time the user sets OC settings (the existing first-apply dialog).
  - Rename the readout label `Frequency Offset` → `Core Offset` (value/units unchanged).
  - Xe Cores line becomes `Xe Cores 32 - Shader Units 4096` (shaders = numXeCores × 16 EUs × 8 shader units per EU; verify against the A770's real 4096).
  - Merge "Service Health" and "IGS" into ONE status source/card (the IGS-specific stuff may become obsolete if the LZ Sysman path lands).
  - Remove Driver Version from the Service Health card; remove Level Zero as a status item.
  - Top-right indicator: just the colored dot + label `Service Status` (drop the verbose "IGS fully off — OC control OK" text; keep a compact inline half-state warning line ONLY when actually half-state, and keep the Disable/Re-enable button functional).
  - Bottom monitoring part more compact; Monitoring-page graphs (M2b) live in a drop-down/collapsible per segment.
- **IGS-independent OC apply path (user request — replaces the flaky IGS-dependent path if proven):**
  - Research first (skatterbencher Arc OC Tool, Acer Predator tool mechanisms; **Level Zero Sysman overclocking API** — `zesDeviceOverclockSet`/`zesFrequencyOverclockSet` etc., ze_loader.dll already present; IGCL registered-UID question). Determine a documented interface that applies clocks/power/offsets/fan without IGS components running.
  - Prototype the winning path behind the existing `IOCBackend` seam (new backend impl or a swapped apply layer), fixture-test the structs, live-probe on the A770 with IGS fully off (service + app) and fully on; keep the IGCL path as fallback.
  - If no independent path is provable, document why (evidence) and keep IGCL + the half-state warning.
  - **Research verdict (2026-08-05, delegated lane):** (1) Shamino's Arc OC Tool is a thin GUI over the SAME IGCL runtime we use — its "works without IGS" is pre-IGS-era evidence, not a different mechanism (skatterbencher.com/arc-oc-tool). (2) Acer BiFrost is a closed UWP with a JSON-profile power-limit injection trick that drivers were already restricting in mid-2023 — dead end. (3) Third-party IGCL UID registration does not exist (zero-UID is the only third-party option; the runtime rejects invented UIDs). (4) **The one structurally different, publicly spec-documented path: direct Level Zero Sysman (`ze_loader.dll` → `zes*`)** — `zesDeviceSetOverclockWaiver`, `zesDeviceEnumOverclockDomains`, `zesOverclockSetControlUserValue` (FREQ_OFFSET/VMAX_OFFSET/POWER_SUSTAINED|BURST|PEAK_LIMIT/TEMP_LIMIT), `zesPowerSetLimits`, `zesFanSetSpeedTableMode`; `ze_loader.dll` ships in System32 with the driver (no oneAPI SDK installed — fetch headers from oneapi-src/level-zero). This bypasses IntelControlLib's UID/arbitration layer; the M2b prototype's key experiment distinguishes runtime arbitration (bypassable) from KMD arbitration (not bypassable by any userspace tool). Intel support article 000100556 documents that IGS's own Tuning tab is service-mediated — consistent with our empirical flap.
  - **Arc OC Tool binary inspection (2026-08-05, ArcTool.zip from skatterbencher.com):** the tool is a Qt app that bundles its OWN IGCL stack from the Jan-2023 era — `IntelControlLib.dll` v1.0.100 + `ControlLib.dll` loader (plus WinRing0, prime95, ASUS CPU libs). The v1.0.100 runtime rejects our (v1.2-era) init args with `0x40000009 UNSUPPORTED_VERSION` (struct layout identical per the oldest repo header; version-field semantics stricter), and the single embedded GUID (`e8e10f95-1a70-4b27-9ccf-02010264e9c8`) is NOT a registered UID (both loaders reject it with `0x40000021`). Conclusion: **the Arc OC Tool is the same IGCL API with an old bundled runtime — it "works without IGS" because IGCL works without IGS (verified directly on this machine: all four controls apply + read-back when IGS is fully off). No bypass mechanism exists; no extractable registered UID.** Bundling the 2023 runtime would be a driver-compatibility liability with zero benefit — do NOT pursue.
  - **Power-limit unlock beyond the reported max (user request, verified 2026-08-05):** on this A770 (a Predator BiFrost card), raw `ctlOverclockPowerLimitSet`/`SetV2` with 280/300 W returns `0x44000004 ERROR_CORE_OVERCLOCK_POWER_OUTSIDE_RANGE` for the zero-UID client — the 252 W cap is enforced in the IGCL runtime, not just reported. Local inspection: BiFrost's UWP app (which applied profiles) is no longer installed; only its logon scheduled task (`\PredatorVGAHelper -checkAutoLaunch`) remains, and its helper DLLs contain no IGCL/OC calls — so the beyond-limit apply must come from Acer's registered application UID (partner-only; not forgeable). **M2b experiment to run: `zesPowerSetLimits` with 300 W (and a read-back) — if the KMD accepts values above 252 W through Sysman while IGCL rejects them, the cap is runtime-level and we get the BiFrost-level unlock legitimately; if Sysman also rejects, the cap is KMD-level and no userspace tool can exceed it.** (User's card is confirmed Predator BiFrost A770; its profile XMLs at %APPDATA%\PredatorBifrost\Presets show PowerLimit values; the active "YoYo" profile left the device at 228 W at probe time.) — **Sysman verdict (M2b-A, run same day): `zesPowerSetLimits` 300 W → `ERROR_NOT_AVAILABLE` (header text: "GPU is under Overclocking, applying power limits under overclocking is not supported" — the card was OC'd at 228 W), OC-domain API unimplemented (`UNSUPPORTED_FEATURE`), reads match IGCL. The cap is KMD-level; **no userspace tool can exceed 252 W on this driver** (BiFrost included). Keep IGCL; the unlock is not reachable.**
- Checkpoints: (1) Sysman/alternate-path research + fixture tests green; (2) live probe on the A770 (IGS off AND on) green; (3) UX refinements (toast suppression, compact tab, floating Apply, menu bar) build+tests; (4) Monitoring + Profiles + tray; full test+build.
- Acceptance: graphs show live data incl. FPS; profile round trip works; apply-on-startup applies and falls back safely; no-op apply shows no toast; floating Apply appears only when dirty; no menu bar; OC applies verified without IGS (or evidence-documented limitation).

### M2C - Make overclocking actually work + UI polish (user-mandated; BLOCKS M3)

User decision (2026-08-05): M3 cannot start until the OC controls (Core
Offset, Voltage Offset, Power Limit, Temperature Limit) are fixed. M2C
splits into M2C-A (OC reliability/capability - vital, first) and
M2C-B (UI/UX polish). The user explicitly requires **status updates at
every phase boundary** (brainstorm, experiments, implementation, tests).

**USER FEEDBACK 2026-08-05 (after M2C-A shipped):** on the live A770,
"none of these Retry-Tries Work" and the retry progress UI "looks very
bad for end-users. Make one that's instant." -> F3's retry-with-verify
is REVISED: the retry loop + progress surfaces are REMOVED entirely
(evidence-consistent: the harness proved retries never changed the
off-window outcome - freq/PL 0/3 with retries, IGS-on 100% single
attempt). New design: ONE attempt, instant result, honest per-control
error with an actionable driver-refusal message (name the IGS-on
requirement for PL/freq). Ships WITH M2C-B as one milestone.

**ROOT-CAUSE REVISION 2026-08-05 (live-machine diagnosis, after M2C-B):**
the IGS-on/off story was WRONG - the real gate is ELEVATION. Live
evidence (this machine, driver 32.0.101.8861, elevated vs non-elevated
probes, delayed read-backs):
- Non-elevated IGCL OC writes NEVER persist (SUCCESS + momentary
  read-back match, then revert; the M2C-A/M2C-B harness "on-window 100%"
  and all earlier "success" evidence was this momentary lie - never
  persistence-verified).
- ELEVATED writes STICK for every control, with IGS fully on AND fully
  off (resetToDefaults also works elevated).
- The >252 W cap is a CLIENT-SIDE clamp in the DriverStore runtime only:
  the 2023 IGCL runtime (bundled in Arc OC Tool, v1.0.100, AppVersion
  1.0, zero UID, waiver set) + elevation writes 280/300/315 W - all
  SUCCESS, persisted, confirmed via the DriverStore runtime's reads in
  separate processes. KMD accepts 315 W. TL likewise: 100/110 C stick;
  125 clamps to 115 C (KMD ceiling). Freq/volt ranges identical.
- Arc OC Tool "works without IGS" because it SELF-ELEVATES; IGS works
  because it runs elevated. The user's Acer hint (BiFrost profile XML
  300 W) was correct that >252 W is reachable; the profile-apply path
  itself is dead (UWP uninstalled, leftover task applies nothing) - but
  the old-runtime+elevation path is OUR unlock.
- Remaining honesty item: 0-value writes are refused even elevated
  (freq 0 / volt 0 no-op) - cleanup uses elevated resetToDefaults.

=> NEW MILESTONE **M2C-C: elevation-aware instant apply + extended
range via the 2023 IGCL runtime** (user-requested: "make one that's
instant"; "no additional programs required"; user awake - UAC prompts
allowed again).

#### M2C-A - OC apply reliability (vital)

**Problem statement.** On the real A770, writes are refused in IGS
half-states and flap on a minute scale even fully on/off (0x40000007 /
0x40000009 family); PL > 252 W is refused with 0x44000004 (zero-UID
client) and via Sysman (KMD verdict - but see E0/E1: that verdict is
API-level evidence, not yet end-to-end proof). The user's premise: the
Arc OC Tool applies OC reliably without IGS - so a way MUST exist.
Prior binary inspection says ArcTool = same IGCL API + 2023 runtime
(v1.0.100) and its GUID is not registered - but the tool was never
actually RUN on this machine, so the premise is unverified empirically.

**Phase A1 - Decisive experiments (probes + host-run, user-assisted GUI where needed; status update after).**
- E0 BiFrost reality check: with IGS fully off, read back the device
  power limit under exactly the reachable configurations: (a) the state
  left by the logon `PredatorVGAHelper -checkAutoLaunch` task (currently
  228 W), (b) each BiFrost preset XML in %APPDATA%\PredatorBifrost\Presets
  re-applied manually if the helper alone cannot, (c) our own apply
  battery (E4) at PL 252. Does ANY of these push the device PL read-back
  above 252 W? Settles whether a >252 W userspace path exists on this
  card at all.
- E1 Run the REAL ArcTool.exe (extracted copy) on this machine: can it
  apply core offset / freq offset / PL / PT today (IGS off; then IGS
  on)? Drive it via PowerShell UIAutomation or user clicks; observe
  read-backs with our IGCL probe while its UI runs. Three defined
  outcomes: (a) it applies values our tool is refused - the difference
  is real and huntable; (b) it refuses or caps at 252 like us - the
  premise is busted; (c) it cannot be started/driven at all (Jan-2023
  Qt app, WinRing0 + ASUS libs, weak Qt UIA support, possible driver-era
  refusal) - route through E3 (mechanistic decider with correct 2023-era
  init args) + A2 evidence; if both fail in driver-era-attributable
  ways, surface the old-driver-reinstall test as an explicit user
  decision in A2 rather than silently dropping the premise. For (b) and
  (c) document with the same harness so the user can see it.
- E2 While E1 runs: capture ArcTool's loaded modules (CIM), child
  processes, service state, %APPDATA% file writes, registry writes -
  what does it actually use (bundled runtime vs driver-store DLL vs
  IGS)?
- E3 Old-runtime init-args reconstruction: load ArcTool's bundled
  IntelControlLib.dll with 2023-era init structs (version fields its
  runtime expects, from igcl repo history around Jan-2023) + its GUID
  e8e10f95-... and attempt OC writes. (Earlier probe used OUR init args
  - 0x40000009; layout matches per oldest header, so only the version
  fields differ.)
- E4 Baseline failure table: our tool, IGS fully off: apply
  {core offset +100, freq offset +100, PL 252, PT 92} x {V1, V2} x
  {cold, after wake-render} - record accept/refuse, codes, read-backs,
  repeated runs.
- E5 OC-authorize hunt: enumerate EVERY OC control type in the igcl
  repo headers looking for an enable/authorize/session control (the
  flapping smells like a missing OC authorization handshake that IGS
  normally performs); test each on-device for an acceptance change.
- E6 Idle-wake hypothesis: GPU low-power (idle/RC6) states reject OC
  writes. Scope: sustained multi-second 3D load (not a single blit -
  one blit may not exit RC6 long enough to disambiguate) and
  apply-during-load; re-run E4's battery under load.
- E7 V1-vs-V2 path comparison for PL/PT specifically.

**Phase A2 - Documentation & archaeology (status update after).**
- Intel docs: igcl repo README/docs OC sections; Intel ISV OC/UID
  registration process (is a registered UID obtainable/forgeable at
  all?); public issues/community threads on 0x44000004, 0x40000007,
  OC-authorize; skatterbencher's Arc OC guide (does he do an explicit
  OC enable?).
- PowerPlay clarification: PowerPlay is AMD terminology; the Intel
  analog is the GFX firmware power budget - no public Windows
  power-table tool for Arc exists; document honestly.
- Deep strings/exports pass on ArcTool's IntelControlLib.dll +
  ControlLib.dll for private escapes/IOCTL names, section names, version
  strings - any non-IGCL path?
- Decide the winning fix candidate(s) (F1..F5) from evidence; confirm
  with the user before implementing.
- Old-driver reinstall question (only if E1 outcome (c) and E3 both fail
  in driver-era-attributable ways): propose to the user as an explicit
  decision whether to test against an older driver package - never
  silently dropped.

**Phase A3 - Implementation (implementer, main-process, checkpointed build+tests; status update after each landing).**
- F1 (if E5 confirms): OC-enable/authorize step in the apply path before
  the first write.
- F2 (if E6 confirms): GPU wake before apply.
- F3 (REVISED 2026-08-05 by user feedback - instant, no retry UI):
  **instant apply**: one attempt per control, zero waiting, no progress
  UI, no cancellation, no budgets. Silent-noop detection STAYS (SUCCESS
  + read-back unchanged = per-control FAIL, never "applied"). Refusals
  fail instantly with an actionable per-control message - for PL/freq
  refusals name the IGS-on requirement ("the GPU driver refused this
  change; power/frequency writes need Intel Graphics Software running -
  start IGS and apply again"); volt/TL refusals get the plain driver
  message. IGS fully-on = single attempt, 100% success (evidence).
  Removed: apply:progress events, "Applying - retry N/9" label,
  apply-cancel IPC, backoff scheduler, APPLY_MAX_RETRIES, budgets.
  Shared by UI Apply, tray, apply-on-startup (one attempt, always
  exits). Regression tests rewritten to pin instant semantics.
- F2/F1/F4/F5: killed by evidence (wake = no effect; no authorize
  control exists - all 29 OC exports bound; old runtime+AppVersion
  1.0+ArcTool GUID unlocks nothing, 315 W claim is a client-gated lie,
  KMD enforces 252; no private surface found).
- F4 (only if E1+E3 unlock something the driver-store DLL cannot):
  isolated legacy-runtime module with documented provenance, or the
  registered-UID path if one exists. - KILLED (E3: nothing unlocked).
- F5 (last resort, user sign-off only): private escape/IOCTL from A2
  strings - only with a concrete verifiable path and explicit user
  approval of undocumented-API risk. - KILLED (no surface found).
- Deliverable: `tools/validate/m2c-acceptance.js` real-device harness
  (battery above) with a pass table: all four controls accepted AND
  read-back matches across >=3 sessions in the fully-off window and >=3
  in the fully-on window, refuse rates documented before/after.

**Phase A1/A2 outcomes (2026-08-05, run + status updates delivered):**
E0: no BiFrost config reaches >252 W (presets cap at 252/YoYo; device
200 W with helper dead). E1: ArcTool runs on today's driver, applied
PL 252 once via OCR-driven UI (device read-back confirmed) while our
identical calls no-op'd - but its own docs say the range is limited to
Arc Control's, its props read the same 252 cap, and the single success
cannot be separated from the off-state flap -> the >252 W premise is
dead on every public path. E2: ArcTool loads its bundled 2022-09
runtime app-dir-first, installs WinRing0 (removed after the run), writes
nothing to %APPDATA%/registry, never touches IGS. E3: old runtime
initializes with AppVersion 1.0 + zero UID; 315 W claim is client-gated
(real sets no-op at KMD); GUID combos fail; identical write behavior.
E4: IGS fully ON = 100% success; IGS off = PL/PT silent no-op (SUCCESS,
read-back unchanged) - matches documented RESET_REQUIRED semantics.
E5: ResetToDefault itself fails (DATA_WRITE) with IGS off; locks always
unlocked; props V0 vs V1 identical; all 29 ctlOverclock* exports bound.
E6/E7: wake/load and V1-vs-V2 make no difference. A2: zero-UID is the
documented default; registered-UID path does not exist; OC is
discrete-GPU-only by driver design (igcl issue #129).

**Phase A4 - Acceptance.** DoD, three reachable branches:
1. Harness green in the fully-off AND fully-on windows (all four
   controls accepted + read-back matches, >=3 sessions each) -> M2C-A
   done, M3 unblocked.
2. Cap proven universal (E0/E1): proof table (same harness, ArcTool
   included), F3 + confirmed fixes shipped, refuse-rate table
   before/after -> the user's sign-off covers BOTH the >252 W cap AND
   any residual four-control refusal, explicitly. **USER SIGNED OFF the
   >252 W verdict on 2026-08-05 (accepted: cap is environmental, DoD
   branch 2). Remaining: F3 + PT clamp shipped, harness refuse-rate
   table, final sign-off on residual refusals.**
3. Neither: evidence table (same harness, ArcTool included),
   refuse-rate before/after, F3 + every confirmed fix shipped, and an
   explicit user decision on the residual four-control refusals
   (harness-green required, or sign-off with documented rates) -> that
   decision is the gate, not an implicit loop.
M3 stays blocked until one branch's gate is met.

- Checkpoints: (1) probe code builds + fixture tests green, THEN
  E0-E4 hardware results recorded; (2) E5/E6/E7 + docs findings
  recorded; (3) F1/F2 landing: build+tests; (4) F3 landing: build+tests
  + harness green; (5) acceptance table.
- Acceptance: as DoD below; updates posted to the user at every phase
  boundary.

#### M2C-B - UI/UX polish (renderer + assets; after M2C-A acceptance; one implementer run, checkpoint after pure helpers)

- B1 Fan curve graph: 0-100% scale as a RIGHT-SIDE axis (mirror of the
  bottom temp axis), labels OUT of the plot (fan.ts: the fan-label texts
  currently sit inside the SVG at x:99/x:1); grid/ticks aligned; pure
  helper updates + tests.
- B2 Dashboard device card: remove the footer chips entirely - the
  "Fan curve N points" chip AND the "Power limit / Voltage offset /
  Core offset / Temp limit" notes are all the `capsSummary` chips footer
  (dashboard.ts:26-34). Overclocking tab stays untouched (user
  confirmed: this point is dashboard-only).
- B3 Header (below the GPU name): replace the driver version line with
  `Arc Power Ver. X.XX` (app version via a new `app:version` IPC +
  preload + types; regression test). Decide the fate of the now-orphaned
  `driver-info` IPC channel and `pure/driver.ts` decode helpers
  (header.ts is their only consumer after this): keep-if-still-used,
  else remove with tests - call the decision out in the report.
- B4 Styled scrollbars inside the client matching the theme
  (::-webkit-scrollbar + scrollbar-color; blue accent).
- B5 Overclocking tab: fix the "Unapplied" chip that does not clear
  after a successful apply. Two separate references (do NOT merge):
  (a) the dirty reference for chips AND the floating Apply button -
  per-`result.ok` control it becomes the applied value (chip clears +
  button hides even when the driver read-back lags); (b) the no-op
  suppression comparison stays against the driver read-back (`before`,
  untouched) so M2b-B's silent-success rule survives. Regression tests:
  chip clears while read-back lags; repeat-apply of an identical value
  stays silent (no "applied" toast for a no-op).
- B6 NEW blue "AP (Arc Power)" icon, designed to look cool and fit the
  program, used EVERYWHERE: a pure-JS PNG/ICO generator script (no new
  deps) producing 16/32/64/128/256 px + .ico; wire into BrowserWindow
  icon, electron-builder icon (package.json build config), the tray icon
  (replaces the current circle-A base64), the sidebar brand, and the
  page favicon. Icon assets committed; generator script tracked.
- B7 Sidebar: blue logo in front of the "Arc Power" line (sidebar-brand
  in app.ts).
- B8 Dashboard device card: keep the max core clock ("Graphics clock")
  row and ADD a "Memory clock" row next to it.
- B9 Dashboard live readout: more compact - 5 tiles, shorter height,
  tighter padding, larger values.
- Visual confirmation by the user at the end.

- Checkpoints: (1) pure helpers (B1 axis math, B5 dirty reference, B3
  version formatting) + tests green; (2) full UI + asset wiring; build,
  `npm test`, `--ui-verify` all variants; (3) user visual check.
- Acceptance: each B item visibly done in the dev tree + ui-verify; new
  icon visible in window, tray, EXE, sidebar.

#### M2C-C - Elevation-aware instant apply + extended range (2023 runtime)

Root-cause revision above (the gate is ELEVATION, not IGS state; the
>252 W cap is a DriverStore-runtime client clamp - the 2023 runtime +
elevation reaches 315 W / 115 C, verified on this machine). User
confirmed 2026-08-05: expose the FULL verified range (PL 315 W,
TL 115 C) with an extra confirm warning above 252 W / 90 C.

**Scope:**
1. Elevation detection (koffi -> shell32 IsUserAnAdmin, cached, exposed
   via IPC). No per-apply process spawn for detection.
2. Elevate-on-apply: non-elevated app spawns an elevated self-worker
   (`--apply-worker <reqFile> <outFile>`, hidden, no tray/window, never
   re-elevates) via PowerShell Start-Process -Verb RunAs -Wait; request
   file = {deviceId, settings, profileName?, requestId}; result file =
   {requestId, ok, perControl, error?}; parent shows a transient
   "Applying..." state (no retry UI), then the existing honest toasts.
   UAC cancel/deny -> "Apply requires administrator approval" toast.
   Elevated app applies in-process (no worker).
3. Per-control runtime routing in the shared apply core: values within
   the DriverStore range (<=252 W / <=90 C) go through the DriverStore
   runtime; PL >252 / TL >90 go through the bundled 2023 IGCL runtime
   (v1.0.100, AppVersion 1.0, zero UID, waiver set; V1 mW/C setters;
   ctl_oc_properties_old_t; delayed verify read ~400 ms - the
   momentary-lie lesson). Old-runtime failure on future drivers degrades
   honestly per-control with a clear message. Extended capability flag
   on getCapabilities; ranges exposed as PL max 315 (min 105, default
   210), TL max 115 (min 60, default 90).
4. Bundle IntelControlLib.dll v1.0.100 (Intel's own BSD-3-Clause IGCL
   from the Arc OC Tool extraction; THIRD_PARTY_NOTICES.txt attribution;
   tracked, asarUnpack'd with koffi). Verify the DLL survives the
   packaged EXE (the known koffi failure mode).
5. apply-on-startup: scheduled task with /rl highest (schtasks create
   at enable-time with ONE UAC; delete at disable; startup-get reports
   the mechanism) so boot applies run elevated silently. Boot worker =
   existing --apply-profile path + worker semantics.
6. Messaging/UX: remove the now-obsolete IGS-naming refusal text (plain
   driver message + code); "extended range" confirm dialog when any
   control exceeds 252 W / 90 C; first-apply elevation explanation.
7. Tests: elevation detect, worker contract (no recursion, hidden mode,
   UAC-cancel path), old-runtime binding fixtures (init/waiver/V1 unit
   conversions), routing (<=252 -> driverstore; >252 -> old; old-fail
   honest), caps exposure + flag, confirm-dialog gating, messaging.
   Live: user-approved UAC apply + real old-runtime 300 W session.
8. Dist: DLL packaged + elevated packaged smoke (user approves one UAC
   at dist time); non-elevated smoke asserts the honest elevation path.

**User sign-off items (M2C-C closes):** residual-refusal DoD item is
superseded (elevation fixes it); the >252 W verdict is REVISED to
"reachable via the 2023 runtime + elevation" (user confirmed exposure).
- Checkpoints: (1) elevation+worker+old-runtime bindings + tests green;
  (2) routing/caps/messaging + full suite green; (3) live UAC apply
  verified by user; dist + packaged smoke.
- Acceptance: user applies PL 300 W via the app (UAC) and the read-back
  sticks; extended range visible in the UI; boot apply via elevated
  task works (next logon); all tests green; dist smoke green.

#### M2C ordering & gates
- M2C-A first (vital; blocks M3), then M2C-B. M2C-B ships WITH the F3
  instant-apply revision (user feedback, 2026-08-05) as one milestone
  commit `M2C-B: ...`, with `npm run dist` + packaged `--headless`
  smoke (exit 0, in a workable IGS window) before commit.
- M2C-C (elevation + extended range) is the final M2C milestone;
  commit `M2C-C: ...` after review + dist + packaged smoke.
- pipeline/ + tools/validate/ stay gitignored; icon assets + generator
  script are tracked.
- Deferred (unchanged): NIT4 tooltip, PresentMon DLL in dist, anything
  not listed above stays untouched.
### M2D - Mock Distribution File: featureset swap (A770 / B580 / Pro B50 / iGPU)

User request (2026-08-05): a mock distribution file with a SWAP between
the featuresets of the A770, B580, an Arc Pro B50, and possibly an Arc
iGPU - so the UI can be developed/tested against every product line
without the hardware.

**Scope:**
1. `mock/featuresets/*.json` - one file per device, the single source of
   truth for the mock backend: deviceName, driverVersion (dotted),
   numXeCores/shaders, graphicsClockMHz, memClockMHz, fan canControl,
   ranges per control (units/min/max/step/default), supported controls,
   extendedRanges (PL/TL max when the 2023 runtime applies), gpuLock/
   vfCurve/vram support, telemetry behavior. Confidence tags per value
   (verified on A770 hardware / estimated-for-mock for B580, Pro B50,
   iGPU - documented as estimates).
   - A770 (Alchemist): current real caps (PL 105-252/ext 315, TL 60-90/
     ext 115, freq 0-300, volt 0-0.234 step 0.005, fan canControl=false,
     gpuLock yes, no VRAM/VF, extendedRanges true, 32 Xe / 4096 shaders).
   - B580 (Battlemage): percent units for volt/PL/TL (BMG non-G31),
     vramMemSpeedLimit in Gbps, VF curve R/W, NO gpuLock, fan
     canControl=true, 20 Xe / 2560 shaders (values = estimates, marked).
   - Arc Pro B50 (BMG pro): OC likely locked - telemetry + fan only,
     no OC controls (estimate, marked).
   - Arc iGPU (Core Ultra / Lunar Lake): telemetry-only, no fan, no OC
     (estimate, marked).
2. Mock backend loads the featureset (RID_MOCK_FEATURESET=<id> env,
   default a770); all caps/ranges/telemetry derive from the file.
3. UI swap: in mock mode a small dropdown (header or dashboard) lists
   the featuresets and swaps live via a new IPC (mock:set-featureset).
   Hidden in real mode.
4. Tests: each featureset parses + yields the right caps/controls; the
   swap round-trips; real mode unaffected; ui-verify exercises B580
   percent units + Pro B50 no-OC + iGPU telemetry-only variants.
- Checkpoints: (1) featureset files + parser + tests green; (2) swap
   UI + mock wiring + full suite + ui-verify.
- Acceptance: dropdown swaps the whole UI's feature surface per device;
   every variant renders without errors; tests green.

### M3 — Registry hacks module (SPLIT: M3-A no-UAC / M3-B UAC)

USER INSTRUCTIONS (2026-08-05): NO UAC for the next hour - anything
needing UAC goes to M3-B, everything else is M3-A. M3-B design question
answered (host): the IGS Status Indicator is REMOVED - with the
elevation gate, IGS state is no longer relevant to OC-applicability;
the general GPU Health indicator stays and is extended to cover:
driver installed correctly, device detected, clocks normal, OC applies
working, app working.

#### M3-A (no UAC needed)
- UI cleanup (user: "clean up the UI some more, especially the AP Logo
  needs work - it looks very very bad right now; I liked the prior
  variant where the Logo was gone and the small blue Bar was below the
  'Arc Power' line"): REMOVE the sidebar logo image; restore the small
  blue accent bar below the "Arc Power" sidebar text. Also: remove the
  IGS status indicator (header dot + "Service Status" label); convert
  the dashboard merged Service Status card into the general GPU HEALTH
  card (driver installed, device detected, clocks sane, OC applies
  working, app healthy); drop the IGS half-state line + Disable/
  Re-enable button; the IGS service probe stays for diagnostics but is
  no longer surfaced as a status item.
- Registry hacks CATALOG + UI + current-state display (read-side only;
  applying = M3-B).
- Checkpoints: UI cleanup + health card + catalog read-side + tests;
  ui-verify all variants.
- Acceptance: header/sidebar match the user's liked variant; no IGS
  indicator anywhere; the health card shows the health items; catalog
  renders + reads current state.

#### M3-B (needs UAC - done when the user is back)
- Apply/enable the registry hacks (MPO disable first; 2-3 more
  well-known, reversible toggles), named revert, elevation relaunch,
  current-state display (apply side).
- M2C-C deferred verifications: live 300 W worker apply (read-back
  sticks), elevated packaged smoke, startup-task live logon test,
  harness re-run, DLL-in-dist re-check with a REAL apply.
- Checkpoints: MPO enable/disable/revert e2e on this machine; elevated
  smoke green; live 300 W verified.
- Acceptance: MPO toggle verified here; UI shows state; M2C-C live
  verifications all green.

### M4 — Version 0.9.10 Alpha + user-requested feature batch (Battlemage conditional)

User requirements (2026-08-06): the milestone is named **0.9.10 Alpha**;
B580/B570 hardware is a possibility (keep M4-E conditional); the OC tab
needs negative territory for the voltage and clock-offset sliders plus a
toggle that turns the clock offset into an actual clock setting
(AMD-Wattman-style, e.g. "1400 MHz runs at ~1400 MHz"); the OC waiver must
be prompted when the program opens and shown as a status
"Accepted"/"Not Accepted" (green/red) — fan-curve applies currently fail
when the waiver is not accepted because it is not prompted; the Fan tab
gets a "Fixed" speed tab, per-point hover+move readouts (% and temp), and
small input boxes below the graph to set each point's % and temp manually
(hover readouts also on the Monitoring page's lines); the Dashboard gets a
CPU card (CPU, cores/threads, clock speed, RAM size + speed) in front of
the GPU card; a new Settings tab with "Start with Windows" and "Start
minimized" toggles. Follow-up requirement (same day): on a machine
without an Intel GPU, detect and display whatever GPU is present in the
device card, show "not an Intel Arc GPU — overclocking won't work" as an
error in the GPU Health card, grey out the Tuning (Overclocking) and Fan
tabs, and remove every other error path about this condition (M4-D2).
The M3-D icon ("new minimal mark") is approved — no icon work in M4.
**Environment note (user, mid-M4)**: NO UAC during the whole M4 process —
the user is unavailable for elevated prompts. All live verifications that
would raise a UAC prompt (M4-B negative-write probe on the A770, M4-C
fixed-mode live probe / live fan apply, M4-D live task create/delete, the
packaged elevated EXE headless smoke) are SKIPPED and recorded as
"deferred live verification (user UAC)" items in the milestone report.
Dev-tree verification that needs no elevation (npm test, typecheck,
build:renderer, electron --ui-verify variants, dev headless smoke) runs
normally. **User add-ons for M4-B**: rename the dashboard health row
"OC working" to "OC Status", and append the GPU VRAM amount to the GPU
display name (e.g. "Intel Arc A770 16 GB") — see M4-B.

#### M4-A — Version 0.9.10 Alpha + waiver prompt-at-open + status pill
- **Version**: `npm version 0.9.10` (syncs package-lock.json;
  tools/probe/package.json is a SEPARATE tool package — leave it, per the
  M3-D precedent). Header display `Arc Power Ver. 0.9.10 Alpha` (display
  label carries the Alpha suffix; the `app:version` IPC keeps the bare
  semver; dist artifact stays Arc-Power-0.9.10.exe). Pins that move:
  test/ipc-core.test.js:594 ('0.2.0' -> '0.9.10'), ui-verify.js:152-153
  ('Arc Power Ver. 0.2.0' -> 'Arc Power Ver. 0.9.10 Alpha').
- **Waiver prompt at open**: in the renderer boot sequence (app.ts, after
  caps land), when `deviceId !== null && caps.waiverAccepted !== true`,
  show the existing waiver dialog (components/waiver-dialog.ts) — Accept
  calls the existing `waiver-accept` IPC (elevated worker in dev /
  in-process in the always-elevated EXE — no UAC in the packaged app),
  Cancel just closes the dialog. Never auto-accept (the smoke
  `allowAutoWaiver` path stays smoke-only). Boot is non-blocking: a
  declined boot prompt must not break the boot sequence.
- **Waiver status row — Dashboard Health card ONLY (user correction,
  mid-M4-A)**: the persistent waiver status is a row in the Dashboard's
  GPU Health card ("OC waiver: Accepted" green / "Not Accepted" red),
  NOT on the Overclocking or Fan page (the user: "only be displayed on
  the Dashboard in the Health Card. Not in the Tuning or Fan Tab").
  When unaccepted, clicking the row opens the waiver dialog (the same
  pop-up that also fires on an apply attempt). Live refresh: the
  dashboard already full-re-renders on caps changes (DashboardSig
  includes caps — dashboardNeedsFullRender), so an accept-time store
  patch (`caps.waiverAccepted: true`) refreshes the row with no new
  helper. **Pins that change**: ui-verify.js:174 (body-wide 'OC waiver'
  fail — M2C-B B2) is reworked to assert the row exists in the health
  card and is ABSENT from the OC/Fan pages; the pill assertions on the
  OC/Fan pages (ui-verify.js:404-405/455-457/1575/1623) move to the
  dashboard health row; the boot-accept flow still patches the store
  caps.
  **Round-1 F2 (live-refresh mechanism — REVISED by the user correction)**
  : the original pill plan needed a `waiverChanged` helper + onUpdate
  branches on both pages; with the status row moved to the Dashboard
  health card, the dashboard's existing full-render-on-caps-change path
  covers the refresh (DashboardSig includes caps). The OC/Fan pages keep
  NO waiver UI beyond the apply-time dialog gate. The boot-prompt Accept
  path (waiver-accept IPC, ipc-core.js:398) never patches the store caps
  — the boot-accept flow must still patch `caps.waiverAccepted: true`
  (and the in-page accepts). `waiverChanged` is only kept if the health
  row needs it; otherwise remove it and its tests.
  **Round-1 F1 (ui-verify waiver-flow rework)**: the existing waiver-flow
  section (ui-verify.js:313-392: "first Apply shows the dialog", cancel
  flow, accept flow, "second apply: no dialog") runs with an unaccepted
  store — the boot prompt now shows the modal BEFORE the apply. Rework:
  (a) boot-accept variant — prompt at boot, Accept → pill green, first
  Apply skips the dialog (the "second apply: no dialog" semantics move to
  "no dialog anywhere after boot accept"); (b) boot-cancel variant —
  Cancel at boot → pill stays red, first Apply shows the dialog (cancel /
  accept flows unchanged); (c) the persisted-acceptance variant
  (ui-verify.js:289-299) must assert NO boot prompt.
  **Round-2 F4 (the boot prompt hits EVERY variant)**: all mock sessions
  boot with an unaccepted store + isolated settings.json, so the boot
  modal would appear in the extended variant (:545 asserts no modal),
  the stock variant (:595), and the featureset-swap variants (:1206-1207
  — the accept click there would close the BOOT prompt, not an apply
  dialog). Rework: a shared deterministic boot-step in EVERY variant —
  assert the prompt appeared once at boot, then Cancel it (Accept in the
  boot-accept variant) BEFORE that variant's own assertions; the
  featureset variant's apply-dialog assertions then see a clean page.
- **Fan-apply gate fix**: the user reports fan-curve applies failing
  without a waiver prompt. Current fan apply (fan.ts:345) already calls
  ensureWaiver — regression-test the unaccepted-waiver fan apply through
  the mock (dialog -> accept -> apply lands; cancel -> apply aborted with
  the honest toast) and verify the packaged always-elevated path applies
  in-process. Root-cause any remaining failure with evidence (the elevated
  worker path is the suspect: waiver-accept in dev is elevated, but the
  packaged app applies in-process).
- Checkpoints: (1) version + pins + suite; (2) boot dialog + status pill
  + fan-gate regression (ui-verify: unaccepted store shows the pill and
  the apply dialog; accepted store skips both); (3) dist + packaged
  smoke — DEFERRED (the EXE requires elevation, no UAC this milestone,
  environment note) + commit + push.

#### M4-B — OC tab: negative territory + absolute-clock toggle (+ gpuLock editor)
- **Negative ranges**: extend the offset ranges into the negative
  half-plane. Mock/featureset mirrors: a770.json gpuFreqOffsetMhz
  0..300 -> -300..300 and gpuVoltOffsetV 0..0.234 -> -0.234..0.234
  (mirrored mins); b580.json gpuFreqOffsetMhz 0..500 -> -500..500 and
  gpuVoltOffsetV 0..100 -> -100..100 (mock %, same mirror rule). The UI
  math (snapToRange / formatValue / clampExposedRange) is range-driven and
  already handles negatives; the REAL ranges come from the IGCL
  properties, which stay the honest bound. **Live probe on the A770 —
  DEFERRED (no UAC during M4, see the environment note)**: write -100 MHz
  and -0.050 V through the app's apply path, read back. If the driver
  refuses, clamp with an honest toast + log and keep the driver-reported
  range — never fake negative support. (Recorded as a deferred live
  verification; the mock mirror + unit tests carry the milestone.)
- **Display-name add-ons (user, mid-M4)**: (1) rename the dashboard
  health row "OC working" to "OC Status" (pure/status.ts healthRows +
  any ui-verify pin); (2) append the VRAM amount to the GPU display name
  everywhere the device name is shown (device card, OC-page dialogs,
  waiver dialog, header) as e.g. "Intel Arc A770 16 GB" — source: the
  backend's device memory info where IGCL exposes it (verify what
  ctlDeviceProperties/ctlGetMemoryInfo give; fallback: sysinfo
  Win32_VideoController AdapterRAM with an honest caveat; no suffix when
  unavailable). Mock/featuresets gain a vramBytes value; the name is
  formatted once in a pure helper (unit-tested) and cached at listDevices
  time (never per-render).
- **Absolute-clock toggle (Wattman-style)**: on the GPU-frequency-offset
  card only, a segmented toggle "Offset / Clock". In Clock mode the slider
  sets a TARGET clock (MHz) and the app converts target -> offset =
  target - baseClock before applying (IGCL only accepts offsets);
  baseClock = the device's default max clock (device.graphicsClockMHz —
  the same value the Dashboard device card shows; captured at render,
  stable per session). Readout, Driver line, and chip show the absolute
  clock (base + offset) in Clock mode. Pure conversion (pure/settings.ts
  or a small pure/clock.ts): clockToOffset / offsetToClock, clamped to the
  range bounds translated by baseClock, rounded at step 1 MHz + unit
  tests. Mock: identical behavior (base from the featureset). Voltage
  offset keeps offset-only semantics (no toggle — the user asked the
  toggle for the clock).
- **gpuLock editor (the M2a deferred note lands here)**: the backend apply
  already exists (igcl-backend.js:810-839 applyLock, mock-backend.js:
  382-389, ipc-core.js:84-87/126); ship the UI — a card in the Advanced
  section with Voltage (V) + Frequency (MHz) inputs + Apply/Reset, gated
  on caps.controls.gpuLock. **Round-1 F3: replace, don't drop, the
  clampGpuLock voltage bound (units.js:150-167)**: the gpuVoltOffsetV.max
  (0.234 V, an offset bound) is nonsense for an absolute lock voltage
  (real locks are ~0.7-1.2 V; the current clamp makes any real lock
  impossible) — but unbounded passthrough of a user-typed voltage into
  `ctlOverclockGpuLockSet` would be a defense-depth regression across all
  three call sites (igcl-backend.js:820, mock-backend.js:388,
  ipc-core.js:126). Ship a documented absolute ceiling + floor:
  `GPU_LOCK_VOLT_MAX_V` ~ 1.5 V, min 0 (0 = "don't touch voltage"), keep
  the frequency ceiling; update units.test.js:86-102 pins accordingly.
  **Round-1 F6 (expert-row text)**: overclocking.ts:432 renders "editing
  arrives in M4" for ALL supported expert controls — after the editor
  ships, the gpuLock row must switch to an honest post-M4-B text (e.g.
  "Editing available" + the card sits in the Advanced section); only the
  vfCurve/vram rows say "M5".
- **vfCurve + vram offsets stay read-only** (no apply path exists): honest
  expert-row text change "editing arrives in M4" -> "M5" for those rows;
  the absolute-clock toggle covers the Wattman-style need for now.
- Checkpoints: (1) pure conversions + clamp removal + tests; (2) UI +
  mock e2e (ui-verify: negative slider reachable, Clock-mode readout +
  chip); (3) live A770 probe of negative writes — DEFERRED (no UAC,
  environment note); (4) dist + smoke + commit + push.

#### M4-C — Fan: Fixed tab + point hover/manual boxes + Monitor hover popups
- **Fixed tab**: the editor already renders a Fixed mode chip, but the
  M3-D probe learned the real A770's modes as ['auto','curve'] (fixed
  writes were UNSUPPORTED_FEATURE, so the derivation never offers it).
  The user wants the tab regardless: render "Fixed" ALWAYS in the mode
  toggle; when 'fixed' is not in caps.fan.modes, show it disabled with the
  honest note "Fixed speed is not supported on this GPU". Extend the M3-D
  probe with a fixed-write sub-probe (one reversible 50% write +
  read-back + restore-to-default): on SUCCESS add 'fixed' to the learned
  modes (mock a770 editable overlay gains 'fixed'); on FAILURE keep
  ['auto','curve'] (existing evidence says failure is expected on the
  A770 — live-verify once, honestly). **Round-1 F7 (sub-probe lifecycle)**:
  the sub-probe MUST share the M3-D one-per-device probe cache
  (igcl-backend.js:282-292 — never a re-probe per caps read), follow the
  write-accepted rule for learned modes, and reuse the restore-retry
  semantics so a failed fixed write NEVER leaves the fan at 50% fixed
  (restore failure = probe failure, honest read-only). **Round-2 F6
  (probe result shape)**: the M3-D cache holds one promise per device
  returning `{probeOk, writeAccepted}` — the fixed sub-probe must extend
  the SAME cached result (e.g. `{probeOk, writeAccepted, fixedOk}`) so
  the fixed probe also runs once per device per session; update the
  fake-lib fixtures (igcl-backend.test.js) and the mock a770 editable
  overlay for the new shape. The Fixed UI
  itself exists (fan.ts:194-210, 0-100% slider) — wire the tab into the
  existing buildFanSettings apply unchanged.
- **Point hover + drag readout**: hovering OR dragging a curve dot shows
  a floating readout (near the dot, above the plot): "85% @ 72 °C" (+
  point index), live-updated during the drag. Hover via the existing dots
  layer (pointerover/out); no math changes.
- **Manual per-point boxes**: a row under the SVG — one input pair (Temp
  °C, Speed %) per point + a per-point remove button; typing updates the
  curve through the existing pure helpers (movePoint for clamp/ascending-
  temp enforcement, point-count clamp), and the selected dot + tooltip
  sync. All math stays in pure/curve.ts (unit tests for the input-driven
  path).
- **Monitor hover popups**: on each Monitoring canvas, pointer-move shows
  a crosshair + popup at the nearest sample on the line (value + relative
  time, e.g. "1410 MHz · 12 s ago"); hidden on pointer-leave; only when
  the segment is expanded. Nearest-sample lookup as a pure helper in
  pure/graph.ts (x-position index -> series point) + unit tests.
- Checkpoints: (1) curve/graph helpers + tests; (2) fan UI (fixed tab,
  hover readout, manual boxes) + ui-verify variants (editable overlay
  gains fixed; RID_MOCK_FAN_READONLY unchanged); (3) monitor hover; (4)
  live fan apply — DEFERRED (no UAC, environment note) + dist + smoke +
  commit + push.

#### M4-D — Dashboard CPU card + Settings tab
- **CPU card** (BEFORE the GPU card in the dashboard card-grid): CPU name,
  cores / threads (physical + logical), max clock speed, RAM total +
  speed. New main-process sysinfo module: PowerShell CIM
  (Win32_Processor Name / NumberOfCores / NumberOfLogicalProcessors /
  MaxClockSpeed; Win32_ComputerSystem TotalPhysicalMemory;
  Win32_PhysicalMemory ConfiguredClockSpeed), cached at boot, new IPC
  channel `sysinfo:get`; fallback to Node os.cpus()/os.totalmem() when
  PowerShell fails (RAM speed row degrades honestly to "—"). Mock
  fixture for ui-verify (fixed values); the dashboard sig
  (dashboardNeedsFullRender) gains sysinfo so the card re-renders when it
  lands.
- **Settings tab** (new page + router entry + NAV label):
  - **Start with Windows**: reuse the M2C-C scheduled-task mechanism
    (schtasks onlogon /rl highest — the packaged EXE is always-elevated
    (M3-C-B), so a plain Run key would UAC at EVERY logon; the task runs
    elevated silently) with a NEW task name (ArcPowerAppOnBoot) launching
    the exe WITHOUT --apply-profile; disable deletes the task + the legacy
    Run key. Startup module gains a plain-app variant (or a sibling
    module) + mock adapter; settings.json persists `startWithWindows`.
    **Round-1 F4 (two-task coexistence)**: the apply-on-boot task
    (ArcPowerApplyOnBoot) and the app task are both `onlogon /rl
    highest` — both enabled would launch the app twice at logon. The
    startup module's parse helpers (startup.js:44-84) regex-require
    `--apply-profile <id>`, so the plain-app entry needs its own parse
    support, and startup-get must report BOTH tasks distinctly. The
    Settings toggle shows both states and enabling one disables the
    other (they cannot coexist).
  - **Start minimized**: persisted setting (`startMinimized`); at boot
    the window starts minimized to the tray (tray exists — tray.js):
    minimize after ready-to-show, tray-click restores. **Round-1 F5
    (tray restore)**: main.js:106-107 toggles on `win.isVisible()` — a
    minimized window reports VISIBLE, so the first tray click would hide
    it instead of restoring. Pin the explicit
    `win.isMinimized() → restore()` branch before the visibility toggle.
    Never show-hidden-then-silent (the user must always be able to
    restore).
  - Settings.json schema: add both fields in profile-store.js
    loadSettings/saveSettings defaults. **Round-1 F8 (migrations)**: the
    fields ride the absent-field defaults mechanism (like ocMode) — NO
    SCHEMA_VERSION bump; just update the migrations v0 comment.
  - The tab shows both toggles with honest current-state lines (startup
    queried read-only like startup-get; enabling needs ONE UAC in dev —
    existing helper) + the app version row.
- Checkpoints: (1) sysinfo module + tests; (2) settings tab + toggles +
  store fields + ui-verify; (3) live task create/delete — DEFERRED (no
  UAC, environment note; start-minimized boot verified via ui-verify
  instead); (4) dist + smoke + commit + push.

#### M4-D2 — Non-Intel GPU detection + honest error state (user requirement)

User requirement (2026-08-06, follow-up): when the app starts on a
machine without an Intel GPU, detect and display whatever GPU is present
in the device card ("GPU tab"), show an error in the GPU Health card that
this is not an Intel Arc GPU and overclocking won't work, grey out the
Tuning (Overclocking) and Fan tabs, and remove every other error path
about this condition.

- **Detection**: IGCL enumerates only Intel adapters, so a non-Intel GPU
  yields zero devices. The M4-D sysinfo module's video-controller query
  (Win32_VideoController: Name, AdapterRAM, VideoProcessor, PNPDeviceID)
  identifies the actual GPU. Boot flow (app.ts): when
  `devices.length === 0` after a healthy health check, use the sysinfo
  video-controller list — first (primary) controller becomes a new store
  slot `nonIntelDevice: { name, vendor?, vramBytes? } | null`. If sysinfo
  also fails or finds nothing, keep a generic bootError as the last
  resort. **Round-2 F1 (the throw paths)**: `devices.length === 0` is not
  the only non-Intel arrival — on a machine with no Intel driver the
  IGCL init can THROW, which today routes to the generic bootError
  ('Device enumeration failed' app.ts:127-131, 'Health check failed'
  app.ts:107-111). Route ALL THREE early-return paths (health throw,
  enumeration throw, zero devices) through the sysinfo video-controller
  detection BEFORE the legacy bootError, and add a test fixture where
  listDevices throws to pin the flow.
- **Dashboard device card**: shows the detected non-Intel GPU (name +
  vendor + VRAM when available) with an "Unsupported" chip — replaces
  the current 'No Intel Arc GPU detected. Install the driver or run with
  RID_BACKEND=mock…' bootError text (that text goes away; it is one of
  the "other errors" the user wants removed). **GPU Health card**: a red
  error row "Not an Intel Arc GPU — overclocking won't work" (level
  error) replaces the failing "Device detected" row wording. Remove other
  error surfaces tied to the missing-Intel-GPU case (healthRows
  pure/status.ts wording + any pinned text in ui-verify).
  **Round-2 F2 (dashboard re-render)**: DashboardSig /
  dashboardNeedsFullRender (pure/status.ts:161-178) keys on
  health/caps/bootError/driverDate only — a standalone `nonIntelDevice`
  store.set would leave the device card on "Searching for a graphics
  device…" (dashboard.ts:97). Add `nonIntelDevice` (+ sysinfo for the
  CPU card) to DashboardSig, and set the slot in the SAME store.set that
  changes the sig.
- **Greyed-out tabs**: the Overclocking and Fan sidebar links render
  disabled (class + tooltip "Requires an Intel Arc GPU"), the pages
  themselves still render the honest no-Intel note if reached directly
  (hash). Monitoring stays enabled (renders its unavailable states),
  Profiles/Tweaks unaffected.
  **Round-2 F3 (sidebar render trigger)**: renderSidebar (app.ts:68-85)
  runs once at boot start + on hashchange only and does not read the
  store — the slot lands after the first call, so the links stay enabled.
  renderSidebar must read `s.nonIntelDevice` (disabled class + tooltip on
  the two links) and boot must re-invoke it when the slot lands.
  **Round-2 F5 (the 'No GPU available.' texts)**: the pages currently
  render 'No GPU available.' (overclocking.ts:164, fan.ts:62,
  profiles.ts:155) and 'Loading device capabilities…' — the user asked to
  remove EVERY error path about this condition, and Profiles is one.
  When `nonIntelDevice` is set, ONE shared honest note ("No Intel Arc GPU
  detected — overclocking and fan control are unavailable. Detected
  GPU: …") replaces all three texts; ui-verify pins those texts updated.
  **Round-3 F1 (branch ordering)**: on OC and Fan the caps-null branch
  renders FIRST ('Loading device capabilities…' overclocking.ts:159-160 /
  'Loading fan state…' fan.ts:57-59) — the non-Intel boot never lands
  caps, so those pages would show the Loading texts, not the honest note.
  The shared note must be the FIRST render branch on overclocking.ts,
  fan.ts, and profiles.ts (keyed on `nonIntelDevice`, before the caps-null
  check), pinned in the ui-verify non-Intel variant.
  **Minor (non-blocking, still do it)**: in the non-Intel state the
  Monitoring FPS note switches to the unavailable note immediately (it
  currently stays "Checking FPS…" forever — monitoring.ts:155 early-
  returns), and the tray's apply-profile balloon on a non-Intel machine
  gets the same honest note instead of a raw failure.
- **Mock + tests**: a mock overlay variant (e.g. RID_MOCK_NON_INTEL_GPU=1)
  that empties the device list and fills the sysinfo fixture with an
  NVIDIA card (modeled on the RID_MOCK_FAN_READONLY overlay precedent —
  main.js:238 mockOpts / mock-backend.js:78 _fanOverlay); a second
  fixture where listDevices throws (F1 pin). The ui-verify variant
  asserts: device card shows the fixture GPU, health card shows the red
  row, OC + Fan links disabled, no legacy bootError text. Real-mode live
  verification is impossible on this machine (A770 present) — the mock
  variants + honest wording are the verification, noted in the milestone
  report.
- Checkpoints: (1) sysinfo video-controller query + mock fixtures +
  tests (incl. the throw fixture); (2) boot state (all three paths) +
  dashboard/health + greyed tabs + shared note + ui-verify variant;
  (3) dist + smoke + commit + push.

#### M4-E — Battlemage enablement (conditional) + hardening + packaging
- B580/B570 on the same IGCL path. **Conditional** (user: "a
  possibility"): no B5xx hardware is confirmed in this environment — if
  B5xx arrives, live-verify and pin capability-matrix fixture
  expectations; otherwise record "unverified on hardware" and pin from
  docs/community reports (the M2D b580 mock exists and stays
  fixture-derived; the M4-B range mirrors apply to it). Do not block the
  release.
- Hardening leftovers (trimmed by M2C-M3D evidence): driver-version
  detection + friendly warnings; retry/backoff; telemetry edge-case
  hardening — the implementer reviews what remains and ships with tests.
- Packaging: NSIS installer (electron-builder); README supported-GPU
  table with "unverified" status markers.
- Checkpoints: hardening + migration tests green (build+tests); installer
  smoke on a clean Windows env — DEFERRED (would need elevation/no-UAC
  rule; documented-absence fallback applies); full manual checklist on
  the A770 — DEFERRED (no UAC); dist + dev smoke + commit + push.
- Acceptance: M4 closes with the 0.9.10 Alpha EXE passing the dev-tree
  headless smoke + the full ui-verify matrix; the elevated packaged
  smoke, the A770 manual checklist, and the B5xx checks are recorded as
  deferred live verifications (user UAC); B5xx per availability above.

### M3-C — Elevation rework, apply-failure fix, OC UX overhaul, monitoring fixes

User request (2026-08-06) after M3-B. Root causes already found by the host
during recon, all evidence-based:

- **Pics 1-2 (apply shows error, tweak applies):** `buildRegApplyScript`
  writes the elevated result file with `Out-File -Encoding utf8`, which in
  PowerShell 5.1 emits a UTF-8 **BOM** (`EF BB BF` — reproduced live). The
  parent's `JSON.parse` rejects the BOM'd string, `parseApplyOutcome`
  returns null, and every real tweak apply is reported as failed/never-run
  while the reg writes actually landed. Unit tests + ui-verify never caught
  it (mock adapter writes no file).
- **Utilization never works:** the real backend's `sampleRawTelemetry`
  never populates `utilPct` (only energy counters + throttle flags).
- **FPS never works:** `tools/presentmon/PresentMonAPI2.dll` exists but
  `PresentMonService.exe` does not -> `pmOpenSession` always fails ->
  permanently "FPS unavailable". Additionally the adapter tracks the app's
  own pid (presents nothing) — even a running service would show no FPS.

#### M3-C-A: BOM fix (tweaks apply false-failure) — small, do first
- `buildRegApplyScript`: write the result JSON with `-Encoding ascii`
  (content is pure ASCII: step indices + booleans). PS 5.1's `-Encoding
  utf8` writes a BOM (proven live); ascii never BOMs.
- `parseApplyOutcome`: defensively strip a leading `\uFEFF` before parse
  (guards any future writer that BOMs).
- Regression tests: (1) `buildRegApplyScript` output contains `-Encoding
  ascii` (pinned); (2) `parseApplyOutcome` parses a BOM-prefixed string;
  (3) existing registry-apply tests stay green.
- Live verification (user UAC): one real tweak apply + revert through the
  app path; the toast must report success honestly.

#### M3-C-B: Distribution EXE runs elevated — no per-action UAC prompts
- electron-builder: **`portable.requestExecutionLevel: "admin"`** — NOT
  `win.requestedExecutionLevel`: verified in electron-builder 26.15.3, the
  win-level setting applies only to the inner app exe while the portable
  wrapper is asInvoker by default and would fail to launch the elevated
  inner exe (ERROR_ELEVATION_REQUIRED). Wrapper-level admin = one UAC at
  launch, nothing inside.
- Post-dist verification: inspect the portable EXE's RT_MANIFEST
  (sigcheck/mt.exe) for requireAdministrator, not just the icon.
- The packaged `--headless` smoke now triggers UAC — run it via the
  elevated harness, and `m3b-elev-smoke.ps1` must itself run from an
  elevated shell (it uses plain Start-Process, no self-elevation).
- Product-path rework (elevation-aware, dev mode keeps the old fallbacks):
  - OC apply: `createApplyRunner` already applies in-process when the
    process is elevated (`needsWorker()` false) — verify + keep; the
    renderer's "Administrator approval needed" toast must be gated on
    `!isElevated` so it never fires in the elevated app.
  - Registry apply: new direct path in the real adapter — when the current
    process is elevated, run `reg.exe` directly via execFile (no
    PowerShell, no RunAs, no result file needed; per-step exec + honest
    per-step reporting stays, UAC-decline wording becomes unreachable in
    the packaged app). Non-elevated fallback (dev) keeps the current
    PowerShell RunAs chain.
- Copy cleanup: dead "requires administrator approval" texts that can no
  longer occur in the packaged app stay for the dev fallback path (gated,
  not removed blindly — ui-verify still exercises the decline path via
  mock).
- Tests: unit tests for the direct reg path (injected execFile); elevation
  wiring covered by existing runner tests.
- NOTE: the IGS-service disable/enable bullets are dropped — dead code
  since M3-A (igs-service.js is imported only for buildElevatedLaunch /
  classifyElevationError); hygiene only, never revived here.

#### M3-C-C: New minimal EXE/window/tray icon (user: "new minimal mark")
- `scripts/make-icon.js`: draw the new brand mark — dark rounded-square
  background + bold blue "A" (or the sidebar's blue-bar motif — implementer
  picks the cleaner at 16-256 px; must read at small sizes), regenerate
  `src/assets/icon.png` (window), `build/icon.ico` (multi-size, electron-
  builder EXE icon), tray icon + favicon from the same source.
- Wire everywhere: BrowserWindow icon, tray nativeImage, electron-builder
  icon (already `build/icon.ico`).
- Verify: built EXE embeds the new icon (check the ico bytes/group icon
  resource in the portable EXE); window + tray show it in a live run.

#### M3-C-D: Power Limit max 400 W + the "above Intel specs" disclaimer
- Raise the extended PL ceiling 315 -> 400 W **in lockstep everywhere
  BEFORE any probe**: old-igcl.js `EXTENDED_PL_MAX_W` (its `_setScalar`
  clamp would otherwise silently cap 400 -> 315 and void the probe),
  backend extended ranges, UI slider max, **mock/featuresets/a770.json
  (`extended.plMax`) AND every test pinning the extended max at 315**
  (old-igcl.test.js, extended-range.test.js, featuresets.test.js,
  igcl-backend.test.js, ipc-core.test.js, mock-backend.test.js,
  apply-routing.test.js AND **ui-verify.js:464 + ui-verify.js:1081** —
  ~9+ files) — checkpoint 2 is GREEN at 400.
  TL stays 115.
- Live test (user UAC, elevated probe): write 400 W, read back. M2C-C
  evidence already pins the KMD ceiling at 315 W — expected outcome: an
  honest 400 refusal (NOT a clamp). Then **pin mock + all tests +
  `EXTENDED_PL_MAX_W` + UI/backend back to the verified ceiling in ONE
  pass** and document that as the answer to the user's 400 W request (the
  "315 pins stay green" claim only holds after this final pinning).
- Disclaimer copy: the Advanced-mode enable confirm explicitly warns:
  beyond Intel's standard limit; depends on card/driver/PSU; the Acer
  BiFrost profile used 300 W.
- **Double-dialog decision (ALL apply paths)**: the per-apply extended
  confirm is redundant in Advanced mode (mode-enable already warned) — in
  Advanced mode the confirm is SKIPPED on the OC tab, the Profiles page
  (profiles.ts:375-376 has the same confirm) AND the tray (main.js:117-144
  — the tray's `requiresExtendedRange` confirm is dropped entirely);
  Stock mode is covered by the gate's refusal + toast/balloon everywhere
  (no dead-end confirm). In Stock mode extended values are impossible via
  the UI and direct requests refuse (M3-C-E gate).
  The ui-verify extended-variant assertions (RID_MOCK_EXTENDED_RANGES,
  ui-verify.js:447-516) are rewritten to the no-dialog-in-advanced
  behavior; the stock-mode variant exercises the refusal path instead.
- Regression test: an above-ceiling apply fails honestly with the refusal
  message — never silently clamps.

#### M3-C-E: Intel OC Mode / Advanced OC Mode toggle
- Persisted `ocMode: 'stock' | 'advanced'` in settings.json (ProfileStore)
  + a settings.json **schemaVersion migration** (ProfileStore migration
  rules). IPC get/set. Real-product default **stock** (Intel-standard
  limits); **mock/ui-verify default advanced** (the extended-flow pins
  stay green — see M3-C-D for the 400/315 ordering across the milestone;
  a stock-mode ui-verify variant exercises the refusal path).
- OC tab: segmented toggle near the top; enabling Advanced shows the
  beyond-Intel-specs disclaimer (M3-C-D wording) + confirm.
- Effect (single gate in main): `getCapabilities` returns the extended
  ranges ONLY when advanced is active (the existing `extendedRanges`
  flag). Mode change must **invalidate the IgclBackend per-device caps
  cache** (igcl-backend.js) and the renderer must **re-fetch caps after
  the toggle**.
- Safety — the gate is an **explicit pre-clamp REFUSAL**, not a clamp,
  and it is **independent of caps caching**: implement it as ONE shared
  pure function keyed on `ocMode` + the STD limits
  (STD_PL_MAX_W/STD_TL_MAX_C), called BEFORE every clamp in
  ipc-core 'apply-settings', applyProfile / apply-on-boot, and
  apply-worker. The worker request file carries `ocMode` (the worker's
  own backend has no mode input and its caps always report extendedRanges
  — a caps-keyed gate there would silently clamp, exactly the forbidden
  behavior). Refusal regression tests for all four paths.
- **Config-refusal classification (boot/tray)**: `applyProfile`'s
  reset-to-defaults fallback runs on ANY `result.ok === false` — a
  mode-refusal is NOT a hardware failure and must NEVER reset the GPU or
  balloon "defaults restored". The gate's refusal reports the mode message
  only and bypasses the reset fallback entirely, in both the boot and tray
  paths. (Critical with the migration defaulting existing users to stock:
  a saved 300 W profile at every logon must refuse cleanly, never wipe the
  live OC state.)
- Boot/tray profile applies with extended values in stock mode: refuse
  with the mode message (tray balloon / boot log).

#### M3-C-F: Dynamic refresh on the Overclocking tab
- After an apply, refresh EVERY card from the fresh device state: the
  "Driver:" readout text (currently built once at render — the stale part
  that forces the leave-and-return dance), slider position, chips.
- Page `onUpdate`: refresh cards in place when the store's state slot
  changes (apply from any page / profile load / tray apply), no full
  rebuild; unit-testable pure signature helper.
- ui-verify: assert the Driver readout updates after an apply without
  navigating away.

#### M3-C-G: Remove Stock/Medium/Max presets; "Applied" green chip
- Remove the per-card preset chips on the OC tab (computePresets call
  site; the pure fn stays for other consumers). "Reset to default" stays.
- Per-control chip states: hidden until the first apply of that control;
  green "Applied" while the current value equals the last applied value;
  warn "Unapplied" once the value differs after applying.
- Update ui-verify OC-flow expectations.

#### M3-C-H: Simplify the tweak explanations (MPO especially)
- registry-catalog.js: shorten every entry's detail/description to 1-2
  plain-language lines (MPO: about fixing stutter/black-screen on some
  setups, off by default in Windows). Step labels (the reg commands —
  pinned by ui-verify toasts) unchanged. Update tests asserting the long
  texts. Don't regress the clean `·` separator (M3-B host fix).

#### M3-C-I: Dashboard rows per the user's 3rd picture (text description)
- Remove the "Clocks normal" health row (pure status.ts + tests +
  ui-verify + the in-place refresh path).
- "Driver installed" row detail: show the driver version + date like the
  device card does (`driverLine(device, s.driverDate)`).
- "Arc Power working" row: healthy detail reads "App & Service Running"
  (app-only — NO IGS probe, per the user's answer; the service phrase is
  the app's own engine/backend). Honest warn/error states as now.

#### M3-C-J: Compact Overclocking tab
- CSS: tighter cards (padding/gap/row height), slider row + value inline,
  single-line meta; the Advanced disclosure stays. Preset-chip removal
  frees space too. Keep every ui-verify structural assertion intact.

#### M3-C-K: Alchemist fan curves — probe IGS/IGCL, live-test on the A770
- Research + probes: (1) grep the bundled 2023 IGCL headers
  (Temp\opencode\igcl-src) for fan-curve/speed functions; (2) inspect the
  installed IGS app/service surface (iGfxSvc / IgsApi or similar) for a
  fan-control endpoint (the user believes IGS can be hooked); (3) if a real
  channel exists, live-test a curve write on the card (elevated probe).
- Expected outcome honesty: A770 fan is firmware-managed (IGCL has no fan
  API for Alchemist; B580 gets IGC fan control in M4). If the probes
  confirm no channel, the Fan page keeps its honest disabled/unsupported
  state (hasFan:false) and the finding is documented in the milestone
  report with the evidence. If a channel exists, wire it into the Fan page
  and live-verify. No silent "applied" claims.

#### M3-C-L: Fix Utilization + FPS monitoring
- Utilization: compute `utilPct` in the real backend's telemetry loop from
  the IGCL activity counters + timestamp deltas (per IGCL's documented
  sample-delta method; globalActivityCounter / renderComputeActivityCounter
  — implementer validates which is populated on this card with a live
  probe). Flows through the existing pipeline to Monitoring + dashboard.
  Mock already provides utilPct; ui-verify unchanged.
- FPS — PMAPI2 v2.5.1 reality (verified against the v2.5.1 header): NO
  `pmStartTrackingAllProcesses`; tracking is per-pid only
  (`pmStartTrackingProcess` / per-pid `pmConsumeFrames`). Mechanism:
  **foreground-window pid tracking as primary** — GetForegroundWindow /
  GetWindowThreadProcessId (koffi user32), re-track on focus change
  (stop old pid, start new); a game/video in the foreground shows its FPS.
  Process-enumeration aggregation is explicitly NOT in scope this
  milestone (documented enhancement).
- PresentMon service — the v2.5.1 PresentMonService.exe is an SCM-service
  binary (per-user standalone run unverified). Verification step (check-
  point 2): extract PresentMonService.exe + PresentMonSharedService.dll
  from the v2.5.1 MSI, run standalone, confirm `pmOpenSession` succeeds.
  If standalone fails: the always-elevated packaged app can
  `sc create`/`sc start` it (dev mode keeps the honest "FPS unavailable"
  degradation). Bundle DLL + service exe + shared dll from the SAME v2.5.1
  release (same-version guarantee), ship in the EXE (asarUnpack — koffi
  needs real files), third-party notices, stop gitignoring them.
- Client restructure: single client, re-trackable pid (start/stop per
  foreground change), pure helper for the pid resolution; unit tests for
  the restructure + aggregation of the sample shape.
- Live verification: browser video fullscreen -> FPS non-null; desktop
  motion -> utilization > 0. Honest "FPS unavailable" stays as the
  degradation when the service cannot start.

#### Checkpoints (build + full test suite between phases)
1. After M3-C-A (BOM fix) + M3-C-B main-side elevation rework.
2. After M3-C-D/E (400 W ceiling in lockstep + OC mode gate in main) +
   M3-C-L backend (utilPct) + **PresentMon feasibility probes** (MSI
   extraction + standalone service spawn test, foreground-pid API check —
   decides the FPS mechanism before any renderer work).
3. After the renderer work (C/F/G/I/J) + M3-C-C icon.
4. After M3-C-K probes + M3-C-L PresentMon bundling/lifecycle wiring; then
   live tests with the user (400 W probe, fan probe, FPS/util live, one
   real tweak apply + revert, one in-process OC apply with no UAC).

#### Acceptance
- Packaged EXE: always elevated (single UAC at launch), new minimal icon,
  no per-action UAC; tweak apply toasts honest (BOM fixed, live-verified);
  OC apply in-process with no prompt.
- OC tab: mode toggle + disclaimer, 400 W max (or the live-verified
  ceiling), dynamic refresh, Applied/Unapplied chips, no presets, compact.
- Dashboard: no clocks row, driver version+date row, "App & Service
  Running" app row.
- Monitoring: utilization + FPS live-verified non-zero on this machine.
- Fan: honest evidence-based outcome (working hook or documented
  unsupported).
- 643+ tests green, tsc 0, ui-verify variants green, dist + packaged
  (elevated) smoke exit 0, commit + push per the pipeline.

### M3-D — Alchemist fan control (the M3-C-K verdict was WRONG — user-corrected)

User report (2026-08-06): IGS shows a WORKING full fan-curve editor for the
A770, not just fixed mode. Deep check done by the host, all live-verified:

- **The M3-C-K "no channel" verdict was wrong.** Evidence: IGS's
  `IntelGraphicsSoftware.Wrapper.IGCL.dll` binds the SAME IGCL fan API we
  implement (ctlFanGetProperties/GetConfig/SetSpeedTableMode/
  SetDefaultMode; string scan of the binaries; `IgclFanTableEntryToTuple`
  in Implementations.dll). IGS's own persisted curve was LIVE on the card
  (a SYSTEM-context probe read mode=2 speed-table mode with fan RPM
  telemetry ~1000-1190 rpm; IGS reapplied it).
- **The unlock is the WRITE ENCODING + a capability probe, not a new
  channel**: `ctlFanSetSpeedTableMode` returns SUCCESS on this A770 when
  the table uses the FAN enum's PERCENT units (1) + Intel's sample
  encoding (Size/Version filled, points ascending). Proven live twice
  (10-pt sample table + a realistic 4-pt curve: SUCCESS, exact read-back,
  restore-to-default clean). Our earlier probes failed because they used
  the general CTL_UNITS.PERCENT (11) instead of the fan enum's 1.
- The fan's `canControl=false` property is a lie on this card (the driver
  honors the writes anyway — same "honest vs reality" split as the
  momentary-lie lesson). Fixed-mode writes are genuinely unsupported
  (supportedModes=0x2 = table only — and the shipped `1<<mode` derivation
  maps 0x2 to `['fixed']`, which live behavior contradicts: fixed writes
  -> ERROR_UNSUPPORTED_FEATURE, table writes -> SUCCESS). The fan speaks
  percent in table mode (supportedUnits=0x1 = RPM is for STATE reads
  only).
- The backend's fan apply (setSpeedTableMode + read-back verify) already
  exists with the correct FAN_UNITS_PERCENT=1 constant — it is gated
  behind caps.fan.canControl, which is false.

#### M3-D scope
1. **Live fan-capability probe (the unlock)**: in the real backend, when
   fans enumerate but properties report canControl=false, run the
   reversible probe ONCE per device per session, cached in a DEDICATED
   promise-keyed map OUTSIDE the caps cache (the caps cache is
   invalidated by ocMode flips — the probe cache must not be, and
   concurrent first calls must share one probe promise, never double
   probe). The probe lives inside `getCapabilities` so the apply gate
   and every later caps call see the effective value. Probe = write
   Intel's sample 10-point table (safe 0-90%, FAN-enum PERCENT units =
   1), read back + verify, restore default mode, verify.
   **Probe-learned modes (round-1 F1)**: live evidence — fixed-mode
   writes are UNSUPPORTED_FEATURE, table writes SUCCESS, default SUCCESS
   — while the shipped `1<<mode` derivation from supportedModes=0x2
   yields `['fixed']` (wrong on this card). The probe therefore learns
   the real modes: probe-ok -> modes `['auto','curve']` (never offer
   fixed unless a fixed-write probe separately succeeds — out of scope,
   do not offer it); the derivation stays for the auto/curve bits only.
   On the probe-FAIL path modes follow the WRITE-ACCEPTED rule: a probe
   whose table WRITE was accepted (a later step failed — stuck restore,
   IGS reapply race) reports `['auto','curve']` (the card demonstrably
   accepts tables; applying 'auto' also retries the stuck restore); a
   write-REFUSED probe keeps the derived modes (claiming auto/curve on
   a genuinely fixed-only card would lie).
   caps.fan.maxCurvePoints from properties (maxPoints, live: 10).
   **Restore-failure safety (round-1 F3)**: if the restore fails, retry
   it; a failed probe must NEVER leave the card in table mode (a stuck
   table mode is itself treated as probe-failure with an honest
   retry/report), and the failure is surfaced (log + fan caps stay
   read-only).
2. **Apply gate**: the fan-apply safety gate uses the effective value
   (properties.canControl || probeOk). **The probe is NOT gated on
   isElevated (round-1 F7)** — the write outcome decides honesty
   (non-elevated dev writes fail -> read-only, no hard gate). Note: the
   packaged `--headless` smoke now triggers one reversible write+restore
   on the first caps read (update the stale smoke.js:13/89-92 comments:
   "never on this A770" is now wrong).
3. **a770 featureset**: fanCanControl -> true + a note documenting the
   live-verified probe path; the mock mirrors the real card's true
   capability (canControl true + modes `['auto','curve']` — the mock's
   FAN_EDITABLE all-three set diverges from the live card; align it).
   RID_MOCK_FAN_READONLY stays as the dev-only read-only overlay.
   **Mock modes alignment (round-2 F1)**: the mock's fan modes align to
   `['auto','curve']` in BOTH the editable and the read-only overlay
   (the card's true modes regardless of control grant — the read-only
   fixture must not claim `['fixed']`, which would repeat the honest-vs-
   reality lie). Pins that move: mock-backend.test.js:32 (editable
   overlay modes), mock-backend.test.js:70 + mock-backend.js:184
   (read-only overlay modes), plus the FAN_EDITABLE constant
   (mock-backend.js:32, all-three -> ['auto','curve']).
   **Pins that break and must move with the flip (round-1 F5)**:
   mock-backend.test.js:44-45 (+ :66 title), featuresets.test.js:51 +
   featureset.test.js:99, and the stale wording in igcl-backend.test.js
   (fake-lib fanCanControl default), mock-backend.test.js:66,
   featuresets.test.js:364, main.js:226-230, igcl-backend.js:2/505
   comments, smoke.js:13, bindings.test.js:244, and docs/igcl-
   integration.md:152/159-161/275. ui-verify fan pins do NOT break
   (default variant opts into the editable fixture already).
4. **Fake-lib probe modeling (round-1 F4)**: igcl-backend.test.js's fake
   lib reports canControl=false with setters returning SUCCESS — a naive
   probe would flip the read-only fixtures to editable and increment
   fanSetters. Model the probe explicitly: probe DISABLED by default
   (fake opts), with probe-ok / probe-fail / restore-fail fixtures +
   regression tests (the existing caps-matrix pin at :267-268 and the
   setters-never-called pin at :428-437 stay green by default).
5. **Version bump per user request (round-1 F6)**: `npm version 0.2.0`
   (syncs package-lock.json); update the pins test/ipc-core.test.js:594
   and ui-verify.js:152-153 ('0.1.0' -> '0.2.0'); tools/probe/package
   .json is a SEPARATE tool package — leave its version (documented);
   dist artifactName follows ${version}.
6. **Correction documentation**: rewrite pipeline/m3c-fan-probe.md +
   plan.md M3-C-K note with the real verdict + evidence.

#### Checkpoints (build + tests between)
1. Backend probe (dedicated cache, learned modes, restore safety) +
   fake-lib modeling + gate + featureset/test pin updates: npm test, tsc.
2. Version bump + docs: full suite + ui-verify variants (default,
   RID_MOCK_FAN_READONLY=1, RID_MOCK_STOCK_MODE=1, RID_MOCK_TWEAKS_APPLY=1).
3. Live with the user (UAC): one real curve apply through the app's
   apply path on the card (write a gentle curve, verify read-back +
   fan RPM change, then restore via the app's Reset/auto button).
4. dist + elevated packaged smoke + commit + push.

#### Acceptance
- The Fan page is editable on the real A770 and a curve apply lands with
  verified read-back + observable RPM response, restore clean.
- Version 0.2.0 in the EXE + header.
- All suites green.

## 10. Test strategy

- `vitest` (renderer + pure modules) and `node:test` (main process).
  FFI layer tested against fixture struct buffers; backends against
  MockBackend; migrations and registry catalog by pure tests.
- Hardware-dependent paths: milestone acceptance checklists on the real
  A770 (no-op applies, cross-validation with IGS UI); `--headless` smoke
  mode for safe verification.
- Every fix in the review loops ships with a regression test.

## 11. Deferred reviewer notes

(none — M3-C/M3-D/M4 plan findings folded into the plan sections; M4
round-3 VERDICT: APPROVED after 2 review rounds, 15 findings folded in)
M0 findings folded into §4a; open M0 risks tracked there (fan
canControl=false interplay, future-driver registered-UID requirement).
