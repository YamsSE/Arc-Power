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

### M4 — Battlemage enablement, hardening, packaging
- B580/B570 on the same IGCL path. **Conditional:** no B5xx hardware is
  available in this environment — if none becomes available, record
  "unverified on hardware", pin capability-matrix fixture expectations
  from the docs/community reports instead, and do not block the release.
- Hardening: driver-version detection + friendly warnings; retry/backoff;
  telemetry edge-case hardening; self-contained .NET sidecar publish if
  the M0 decision picked the fallback.
- M2a review note (deferred): when gpuLock editing lands, drop the
  voltage clamp in `clampGpuLock` (units.js — the voltage-offset max is
  the wrong bound for absolute lock voltages; leave voltage to driver
  validation or derive a proper bound) and keep the frequency ceiling.
- Packaging: NSIS installer (electron-builder); README with
  supported-GPU table and "unverified" status markers.
- Checkpoints: hardening + migration tests green (build+tests); sidecar
  publish smoke (if applicable); installer smoke on a clean Windows env.
- Acceptance: full manual checklist on the A770; B5xx per availability
  above.

## 10. Test strategy

- `vitest` (renderer + pure modules) and `node:test` (main process).
  FFI layer tested against fixture struct buffers; backends against
  MockBackend; migrations and registry catalog by pure tests.
- Hardware-dependent paths: milestone acceptance checklists on the real
  A770 (no-op applies, cross-validation with IGS UI); `--headless` smoke
  mode for safe verification.
- Every fix in the review loops ships with a regression test.

## 11. Deferred reviewer notes

(none — round-2 findings all folded into the plan; round-2 VERDICT: APPROVED)
M0 findings folded into §4a; open M0 risks tracked there (fan
canControl=false interplay, future-driver registered-UID requirement).
