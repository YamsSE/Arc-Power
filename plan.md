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
- Checkpoints: (1) Sysman/alternate-path research + fixture tests green; (2) live probe on the A770 (IGS off AND on) green; (3) UX refinements (toast suppression, compact tab, floating Apply, menu bar) build+tests; (4) Monitoring + Profiles + tray; full test+build.
- Acceptance: graphs show live data incl. FPS; profile round trip works; apply-on-startup applies and falls back safely; no-op apply shows no toast; floating Apply appears only when dirty; no menu bar; OC applies verified without IGS (or evidence-documented limitation).

### M3 — Registry hacks module
- Catalog (MPO disable first; 2–3 more well-known, reversible toggles),
  named revert, elevation relaunch, current-state display.
- Checkpoints: catalog tests; MPO enable/disable/revert e2e on this
  machine; build+tests.
- Acceptance: MPO toggle verified here; UI shows state.

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
