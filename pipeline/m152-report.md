# M152 milestone report

**Date:** 2026-09-02
**Scope:** generic multi-GPU dashboard, telemetry, tuning, profiles, recording targets, and GPU-family presentation

## Delivered

- Generic physical-adapter identity is used for multi-GPU telemetry, VRAM usage, utilization, ReBAR, dashboard cards, tuning selection, profiles, overlay refreshes, and recording targets. The implementation is not limited to A770/B580 combinations.
- The Dashboard shows one GPU card and telemetry lane per physical GPU in multi-GPU systems, without a Dashboard GPU selector. Startup prefers an explicit display-driving discrete GPU when available.
- Battlemage tuning presents VRAM frequency as whole MHz, voltage as mV, temperature as °C, and power/PL1/PL2 as W. Battlemage hides the Stock/Advanced toggle; Alchemist retains it where supported.
- Tuning profiles carry their physical GPU key/name, allowing one active profile per GPU and multiple active profiles across a multi-GPU system.
- Recording exposes GPU-plus-codec choices and forwards the selected adapter target to the bundled capture runtime. Both GPUs' AV1, HEVC, and H264 choices are independently addressable when enumerated.
- The Alchemist GPU icon is packaged at `src/assets/device-icons/gpu/intel-arc-alchemist.png`; the existing Arc icon remains the Battlemage icon.
- UAC/elevation behavior was not changed by this milestone.

## Verification

- `npm run typecheck`: passed.
- `npm run build:renderer`: passed.
- Focused pure tests: 28 passed.
- UI verification: default, B580, generic multi-GPU, and mixed multi-GPU cases passed with exit 0.
- `npm run smoke`: passed against the two detected physical adapters (A770 and B580).
- Full `npm test`: remains non-green on existing broader-suite routing/sysman, legacy documentation/fixture, and contract pins outside this milestone; the new focused and UI coverage is green.

## Distribution

- `npm run dist`: produced `dist/Arc-Power_Installer.exe` and `dist/Arc-Power_Portable.exe`.
- 7-Zip archive tests: passed for both EXEs.
- Packaged `--headless` smoke: exit 0 for both EXEs.
