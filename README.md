<p align="center">
  <img src="src/assets/icon.png" alt="Arc Power" width="120">
</p>

<h1 align="center">Arc Power</h1>

<p align="center"><b>1.1.1 Alpha</b> - overclocking and tuning tool for Intel Arc GPUs, in the spirit of MSI Afterburner, AMD Adrenaline, and Intel Graphics Software - built on Intel's official Graphics Control Library (IGCL), with no reverse-engineering and no third-party daemons required.</p>

## Features

- **Tuning** - power limit (W), core frequency offset (MHz), voltage offset, and temperature limit (°C), applied through Intel's documented IGCL API with a warranty-waiver gate and read-back verification on every apply. Expert controls (VRAM frequency offset, VRAM voltage offset, GPU voltage lock, custom VF curves) appear only on hardware that reports them.
- **Extended range** - on Alchemist, power limits up to **315 W** and temperature limits up to **115 °C** (elevation prompt + explicit confirm required).
- **Fan control** - auto / curve / fixed modes with an interactive SVG curve editor and adaptive presets (Driver Curve / Quiet / Max) derived from the driver's own curve.
- **Live telemetry** - clocks, temperatures, power, fan RPM, utilization, FPS / frame-time, and VRAM usage, as readouts and rolling graphs. The dashboard also shows a CPU card (RAM type, L1-L4 caches) and a two-group live readout with CPU wattage and GPU utilization.
- **In-game overlay** - a click-through, always-on-top stats overlay (MSI Afterburner/RTSS-style): clocks, temps, FPS with 1% Low / 99% FPS percentiles, and a frametime polyline. Hotkey toggle, 4-corner positioning, size/scale, text colors, and an optional background.
- **Graphics tuning** - XeSS Frame Generation override (2x/3x/4x), frame synchronization, an FPS limit (30-300), and Low Latency (Off/On/On+Boost), applied through the IGCL 3D-feature API on the dedicated Graphics page.
- **Multi-GPU** - pick which Intel Arc GPU to control; the choice persists and applies to the dashboard, tuning, telemetry, waiver, and boot/tray applies.
- **UI themes** - Dark Steel (default), Midnight, and Arctic Light, selectable in Settings and persisted.
- **Profiles** - save, load, and apply named profiles, optionally at every startup/logon (silently, via an elevated scheduled task on the installed build).
- **Reversible tweaks** - registry hacks (MPO disable, HAGS, and more) with one-click Enable / Disable / Revert.
- **Graceful fallback** - on non-Intel GPUs the app boots into a "Non supported GPU" state, keeps CPU/RAM telemetry live, and shows no raw error text.

Details on expert controls, the safety design, and the capability model live in [docs/features.md](docs/features.md).

## Supported GPUs

| GPU | Family | Status |
|---|---|---|
| Arc A3 / A5 / A7 series (incl. A770) | Alchemist | **Verified** |
| Arc B580 / B570 | Battlemage | Code paths complete, unverified on hardware |
| Arc Pro B50 | Battlemage (pro) | Estimated - OC may be locked, telemetry + fan only |
| Arc iGPU (Core Ultra) | - | Estimated - telemetry only |

## Requirements

- Windows 10/11, x64
- An Intel Arc GPU with the Intel graphics driver installed
- Administrator approval - dev builds delegate applies that need it to an elevated self-worker (one UAC prompt); the installed app is always elevated, so applies and apply-at-logon need no prompts. The portable EXE runs unelevated and routes applies through the elevated self-worker when needed.

## Getting started

Releases are not published yet (roadmap below). To run from source:

```bash
npm install
npm start
```

Build the packaged apps instead:

```bash
npm run dist
# dist\Arc-Power-<version>.exe   (portable)
# dist\Arc-Power-Setup-<version>.exe  (installer)
```

## Usage

The app is organized into tabs:

- **Dashboard** - GPU card (name, clocks, PCIe link, ReBAR status, health), CPU card (RAM type, L1-L4 caches), and a two-group live readout with CPU wattage and GPU utilization.
- **Tuning** - the Overclocking and Fan pages. Sliders with step snapping and min/max/step ticks, preset chips, per-control Apply, one-click reset to defaults, plus a Save-as-Profile / Override-Profile card. First OC apply shows the warranty-waiver dialog; values above the standard range ask for explicit confirmation. The fan page offers auto / curve / fixed modes with an interactive SVG curve editor (hover/drag readouts, adaptive presets); fan control is read-only on boards that report `canControl = false`.
- **Graphics** - XeSS Frame Generation override, frame synchronization, FPS limit, and Low Latency, mirrored from Intel Graphics Software.
- **Monitoring** - telemetry readout grid and rolling graphs.
- **Overlay Settings** - the in-game overlay: enabled stats, position, size, colors, background, hotkey, and the enable toggle.
- **Profiles** - save and manage named profiles, toggle apply-on-startup.
- **Tweaks** - reversible registry hacks (e.g. MPO disable).
- **Settings** - start with Windows, start minimized, close to tray, log to file, UI theme, and version info.

## How it works

- **App shell** - an Electron desktop app (main process + renderer), single instance.
- **Backend** - the app talks directly to Intel's IGCL runtime (`IntelControlLib.dll`, located in the DriverStore at launch) through [koffi](https://github.com/koffi-ai/koffi), a pure-JS FFI library - no C++ toolchain needed. OC state applies and read-backs are verified against the driver.
- **Elevation** - dev builds and the portable EXE delegate applies that need it to an elevated self-worker (one UAC prompt); the installed EXE is always elevated, so applies run in-process with no prompts. Boot/logon applies run through an elevated scheduled task on the installed build.
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
- [x] Installer (portable EXE + NSIS setup) and silent elevated logon applies
- [x] 1.0.x Alpha feature batch (multi-GPU, themes, dashboard, fan presets, in-game overlay, graphics tuning)
- [ ] Published releases on GitHub
- [ ] Battlemage enablement (live verification on B580 / B570)

## Disclaimer

Overclocking voids warranties and can damage hardware. Arc Power respects the ranges Intel reports and never overrides driver-level ceilings; use the extended range at your own risk. This project is not affiliated with or endorsed by Intel Corporation.

## License

[GNU General Public License v2.0](LICENSE). Third-party components and their licenses are documented in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
