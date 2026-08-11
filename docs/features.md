# Arc Power - Feature details

The deeper feature set behind the [README](../README.md) key features. This page
is end-user documentation; architecture and IGCL integration notes live in the
other files of this directory.

## Expert controls

Capability-gated and hidden when the GPU does not expose them:

- VRAM frequency offset
- VRAM voltage offset
- GPU voltage lock
- Custom VF curves

These controls only appear on hardware that reports support for them.

## Extended range

On Alchemist (A770-class), power limits up to **315 W** and temperature limits
up to **115 °C** are available through a bundled 2023-era IGCL runtime (Intel's
own, BSD-3-Clause, attributed in `THIRD_PARTY_NOTICES.txt`), which the
kernel-mode driver still accepts. Values above the standard 252 W / 90 °C
require an elevation prompt and an explicit confirm.

## Safety design

- **Clamped ranges** - every value is bounded to the device-reported minimum
  and maximum in both the UI and the backend; Arc Power never overrides
  driver-level ceilings.
- **Verified read-backs** - every apply is confirmed by reading the value back
  from the driver, including a delayed re-read to catch momentary "lies". A
  setter returning success but leaving the read-back unchanged is reported as a
  failure, never as "applied".
- **Honest refusals** - when the driver refuses, you get a truthful per-control
  error with a message you can act on, never a silent failure or a fake success
  state.

## Runtime capability detection

Limits, ranges, steps, and units are read from the GPU at launch - never
hardcoded. The UI only shows what the device actually supports.

## System tray

Quick access and apply-on-startup controls without opening the window.

## Elevation model

- Dev builds delegate applies that need it to an elevated self-worker (one UAC
  prompt per apply).
- The packaged EXE is always elevated, so applies run in-process with no
  prompts; apply-on-startup runs through an elevated scheduled task.
- The warranty-waiver gate is prompted at open and on first apply; acceptance
  is permanent, and an apply that hits an unset waiver re-prompts once and
  retries automatically. OC-locked GPUs (Arc B50 / Arc Pro B50-class - the
  driver refuses `ctlOverclockWaiverSet` with `ERROR_UNSUPPORTED_FEATURE`)
  have no waiver: no prompt, the dashboard row reads "Not supported on this
  GPU", and fan/profile applies skip the gate (the driver's per-control
  refusals are the honest floor).

## Overlay and monitoring accuracy

- **FPS** - the displayed frame rate is a 400-600 ms window of the DXGI
  presentation sampler (previously a laggy 1-second average); the AVG FPS
  stat is the last 10 seconds of frames. On the windowed desktop the count
  tracks the display refresh rate, not the game's render rate - the honest
  limit of the unelevated DXGI path.
- **API badge** - the foreground graphics API is detected from the process's
  loaded modules: Vulkan and OpenGL-with-a-vendor-ICD rank above DirectX, a
  bare system OpenGL falls through to DirectX, and launcher-owned windows
  fall back to the child process that renders.
- **Chip-name labels** - an overlay toggle shows the CPU/GPU row labels as
  the chip names (for example "A770" or "i7 5775C") instead of "GPU"/"CPU".
- **Temperatures** - CPU, GPU and VRAM temperatures round to whole degrees;
  AMD Ryzen CPU wattage comes from the RAPL energy counters (with an honest
  status in the log when the counters are unavailable or frozen).
- **RAM brand** - the JEDEC manufacturer decode covers more raw encodings,
  with a part-number fallback for modules whose SPD brand string the board
  BIOS reports as "Unknown".
