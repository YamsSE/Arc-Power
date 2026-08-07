<p align="center">
  <img src="src/assets/icon.png" alt="Arc Power" width="120">
</p>

<h1 align="center">Arc Power</h1>

<p align="center"><b>0.9.11 Alpha</b> - overclocking and tuning tool for Intel Arc GPUs, in the spirit of MSI Afterburner, AMD Adrenaline, and Intel Graphics Software - built on Intel's official Graphics Control Library (IGCL), with no reverse-engineering and no third-party daemons required.</p>

## Features

- **Overclocking** - power limit (W), core frequency offset (MHz), voltage offset, and temperature limit (°C), applied through Intel's documented IGCL API with a warranty-waiver gate.
- **Extended range** - on Alchemist, power limits up to **315 W** and temperature limits up to **115 °C** (elevation prompt + explicit confirm required).
- **Fan control** - auto / curve / fixed modes with an interactive curve editor, per-point readouts, and manual entry.
- **Live telemetry** - clocks, temperatures, power, fan RPM, utilization, FPS / frame-time, and VRAM usage, as readouts and rolling graphs.
- **Profiles** - save, load, and apply named profiles, optionally on every startup.
- **Reversible tweaks** - registry hacks (MPO disable, HAGS, and more) with one-click Enable / Disable / Revert.

Details on expert controls, the safety design, and the capability model live in [docs/features.md](docs/features.md).

## Supported GPUs

| GPU | Family | Status |
|---|---|---|
| Arc A3 / A5 / A7 series (incl. A770) | Alchemist | **Verified** on A770 (primary dev target); A3/A5/A7 expected - same IGCL surface |
| Arc B580 / B570 | Battlemage | Code paths complete, unverified on hardware |
| Arc Pro B50 | Battlemage (pro) | Estimated - OC may be locked, telemetry + fan only |
| Arc iGPU (Core Ultra) | - | Estimated - telemetry only |

## Requirements

- Windows 10/11, x64
- An Intel Arc GPU with the Intel graphics driver installed
- Administrator approval - one UAC prompt per elevated apply in dev builds; the packaged EXE runs always-elevated, so extended-range applies and apply-on-startup need no prompts

## Getting started

Prebuilt releases are not published yet. To run from source:

```bash
npm install
npm start
```

Run the packaged app instead (portable EXE):

```bash
npm run dist
# dist\Arc-Power-<version>.exe
```

## Usage

The app is organized into tabs:

- **Dashboard** - GPU summary, live readouts (core/memory clock, temperature, power, fan), and health status.
- **Overclocking** - sliders with step snapping and min/max/step ticks, preset chips, per-control Apply, one-click reset to defaults. First OC apply shows the warranty-waiver dialog; values above the standard range ask for explicit confirmation.
- **Fan** - auto / curve / fixed modes with an interactive SVG curve editor (hover/drag readouts, manual per-point boxes); fan control is read-only on boards that report `canControl = false`.
- **Monitoring** - telemetry readout grid and rolling graphs.
- **Profiles** - save and manage named profiles, toggle apply-on-startup.
- **Tweaks** - reversible registry hacks (e.g. MPO disable).

## How it works

- **App shell** - an Electron desktop app (main process + renderer).
- **Backend** - the app talks directly to Intel's IGCL runtime (`IntelControlLib.dll`, located in the DriverStore at launch) through [koffi](https://github.com/koffi-ai/koffi), a pure-JS FFI library - no C++ toolchain needed. OC state applies and read-backs are verified against the driver.
- **Elevation** - dev builds delegate applies that need it to an elevated self-worker (one UAC prompt); the packaged EXE is always elevated, so applies run in-process with no prompts. Boot applies run through an elevated scheduled task.
- **Extended range** - values above the driver-store runtime's client-side caps are routed to a bundled 2023-era IGCL runtime (Intel's own, BSD-3-Clause, attributed in `THIRD_PARTY_NOTICES.txt`), which the kernel-mode driver still accepts.
- **Honesty** - a setter returning success but leaving the read-back unchanged is reported as a failure, never as "applied".

## Development

```bash
npm test          # node:test suite (main process, backends, pure modules)
npm run typecheck # TypeScript check (renderer)
npm run smoke     # headless dev-tree smoke against the real GPU
```

Architecture notes and the IGCL integration write-up (struct mappings, capability matrix, findings) live in `docs/`.

## Roadmap

- [x] Core overclocking and tuning (OC, fan, telemetry)
- [x] Profiles, apply-on-startup, system tray
- [x] Reversible tweaks (MPO disable and more)
- [x] 0.9.11 Alpha feature batch
- [ ] Installer and published releases
- [ ] Battlemage enablement (live verification on B580 / B570)

## Disclaimer

Overclocking voids warranties and can damage hardware. Arc Power respects the ranges Intel reports and never overrides driver-level ceilings; use the extended range at your own risk. This project is not affiliated with or endorsed by Intel Corporation.
