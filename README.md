# Arc Power

Overclocking and tuning tool for Intel Arc GPUs, in the spirit of MSI Afterburner, AMD Adrenaline, and Intel Graphics Software — built on Intel's official Graphics Control Library (IGCL), with no reverse-engineering and no third-party daemons required.

## Features

- **Overclocking** — power limit (W), core frequency offset (MHz), voltage offset, and temperature limit (°C), applied through Intel's documented IGCL API with a warranty-waiver gate.
- **Extended range** — on Alchemist (A770-class), power limits up to **315 W** and temperature limits up to **115 °C** through the bundled 2023 IGCL runtime; values above the standard 252 W / 90 °C require an elevation prompt and an explicit confirm.
- **Expert controls** (capability-gated, hidden when unsupported) — VRAM frequency offset, VRAM voltage offset, GPU voltage lock, and custom VF curves; enabled on hardware that exposes them.
- **Live telemetry** — GPU clock, memory clock, temperatures, power (derived from GPU energy counters), fan RPM, utilization, throttle-reason flags, plus FPS / frame-time via PresentMon and VRAM usage via DXGI, rendered as readouts and rolling graphs.
- **Profiles** — save, load, rename, and delete named profiles; optional apply-on-startup through an elevated scheduled task with safe default fallback.
- **System tray** — quick access and apply-on-startup controls without opening the window.
- **Safety-first applies** — every value is clamped to the device-reported range in both the UI and backend, every apply is verified by read-back (including a delayed re-read to catch momentary "lies"), and refusals surface as honest per-control errors with actionable messages.
- **Runtime capability detection** — limits, ranges, steps, and units are read from the GPU at launch, never hardcoded; the UI only shows what the device actually supports.

## Supported GPUs

| GPU | Family | Status |
|---|---|---|
| Arc A770 | Alchemist | **Verified** (primary development target) |
| Arc A3/A5/A7 series | Alchemist | Expected — same IGCL surface |
| Arc B580 / B570 | Battlemage | Code paths complete, unverified on hardware |
| Arc Pro B50 | Battlemage (pro) | Estimated — OC may be locked, telemetry + fan only |
| Arc iGPU (Core Ultra) | — | Estimated — telemetry only |

Capability details per device are available in mock mode (below) for UI development without the hardware.

## Requirements

- Windows 10/11, x64
- An Intel Arc GPU with the Intel graphics driver installed
- Administrator approval (one UAC prompt) to apply extended-range values and to enable apply-on-startup

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

- **Dashboard** — GPU summary, live readouts (core/memory clock, temperature, power, fan), and health status.
- **Overclocking** — sliders with step snapping and min/max/step ticks, preset chips, per-control Apply, one-click reset to defaults. First OC apply shows the warranty-waiver dialog; values above the standard range ask for explicit confirmation.
- **Fan** — auto / curve / fixed modes with an interactive SVG curve editor (fan control is read-only on boards that report `canControl = false`).
- **Monitoring** — telemetry readout grid and rolling graphs.
- **Profiles** — save and manage named profiles, toggle apply-on-startup.
- **Tweaks** — reversible registry hacks (e.g. MPO disable).

## Mock mode

Develop and test against any product line without the hardware:

```bash
npm run smoke:mock
```

A dropdown in the UI swaps between feature sets for the A770, B580, Arc Pro B50, and Arc iGPU, each backed by a JSON definition file (`mock/featuresets/*.json`). Values for hardware not available in this environment are marked as estimates.

## How it works

- **Backend** — the app talks directly to Intel's IGCL runtime (`IntelControlLib.dll`, located in the DriverStore at launch) through [koffi](https://github.com/koffi-ai/koffi), a pure-JS FFI library — no C++ toolchain needed. OC state applies and read-backs are verified against the driver.
- **Elevation** — applies that need it are delegated to an elevated self-worker (one UAC prompt); boot applies run through an elevated scheduled task.
- **Extended range** — values above the driver-store runtime's client-side caps are routed to a bundled 2023-era IGCL runtime (Intel's own, BSD-3-Clause, attributed in `THIRD_PARTY_NOTICES.txt`), which the kernel-mode driver still accepts.
- **Honesty** — a setter returning success but leaving the read-back unchanged is reported as a failure, never as "applied".

## Development

```bash
npm test          # node:test suite (main process, backends, pure modules)
npm run typecheck # TypeScript check (renderer)
npm run smoke     # headless dev-tree smoke against the real GPU
```

Architecture notes and the IGCL integration write-up (struct mappings, capability matrix, findings) live in `docs/`.

## Roadmap

- [x] M0 — IGCL validation on the A770 (probe, capability matrix, decision records)
- [x] M1 — Core backend (koffi binding, telemetry service, profile store)
- [x] M2a — UI core (design system, overclocking, fan)
- [x] M2b — Monitoring, profiles, tray, UX redesign
- [x] M2C — OC reliability, instant apply, elevation-aware extended range
- [ ] M2D — Mock distribution files (A770 / B580 / Pro B50 / iGPU feature sets)
- [ ] M3 — Registry hacks module (MPO disable and other reversible tweaks)
- [ ] M4 — Battlemage enablement, hardening, installer, published releases

## Disclaimer

Overclocking voids warranties and can damage hardware. Arc Power respects the ranges Intel reports and never overrides driver-level ceilings; use the extended range at your own risk. This project is not affiliated with or endorsed by Intel Corporation.
