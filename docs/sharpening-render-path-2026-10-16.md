# Image sharpening investigation — 16 October 2026

## Result so far

The old IGCL game-sharpening feature (feature ID 7) is unavailable in the current IGCL library on the tested Intel Arc B580 and driver 32.0.101.9150. The bundled 2023 IGCL library accepts its 0–100 per-game value and reads it back, but the user saw no visible result in Expedition 33 (DX12) or Palworld (DX11) after a full restart. Driver state read-back is not proof of a rendered effect.

The previous ReShade prototype produced the expected sharpened pixels in controlled DX11 and DX12 samples, but required placing files in game directories. That workflow is superseded because the requested feature must work without setup, downloads, or game-folder changes.

## Current replacement under test

Arc Power now has a native DXGI Desktop Duplication helper under test. It captures the composed monitor output on the Intel Arc adapter, crops to the foreground window bounds, applies an Arc Power-authored D3D11 unsharp-mask shader, and presents the result in a click-through overlay. The app sends the active process ID and effective percentage over a private stdin pipe. It does not inject a DLL, install an API layer, request capture consent, download a runtime, or write to game directories.

- Graphics → Image Sharpening and Game Profile → Graphics → Image Sharpening use integer sliders from **0% to 100%** in **1%** steps.
- A global switch gates all sharpening. Each game can inherit the global value or store its own enable/value override.
- Global sharpening now requires an exact executable match in Arc Power's Game Profile catalog. Common desktop application executables remain excluded even if manually catalogued. On the first unknown foreground executable, a single conservative background discovery merges into the catalog without removing saved game profiles; unknown games can be added through Game Profiles. Foreground polling uses an in-memory path cache, invalidated by catalog writes, instead of repeatedly parsing embedded artwork.
- The game gate does not restrict window styles: windowed, borderless, fullscreen, and exclusive fullscreen game windows are eligible on a monitor connected to Intel Arc. Eligibility does not establish capture/presentation compatibility. Exclusive fullscreen, protected content, anti-cheat behavior, hybrid-display routing, and specific games have not been established yet. The helper currently fails closed for rotated or mismatched output dimensions.
- The overlay uses a top-level layered window with `WS_EX_TRANSPARENT` and full opacity. Windows documents this style combination as passing mouse input through a layered window; the helper no longer depends on `HTTRANSPARENT`, which only forwards within the same thread. Per-monitor DPI awareness is enabled before creating any native windows, with a per-monitor fallback for older supported Windows builds. Input delivery and alignment still need a visible-window test at mixed DPI.
- Desktop Duplication captures the composed display rather than the game's API, so it can in principle process DX9/DX10/DX11/DX12 and OpenGL output. Microsoft documents DirectX and OpenGL support; Vulkan is not explicitly named in the documentation. None of these statements establish compatibility with a particular game or anti-cheat. DX9, DX10, DX11, DX12, Vulkan, and OpenGL game paths still need visual and runtime testing.
- The app-owned overlay uses `WDA_EXCLUDEFROMCAPTURE`. A controlled B580 probe verified that this overlay was omitted by Desktop Duplication on the tested display, avoiding recursive capture there. This behavior is not a universal guarantee for every driver/compositor. Desktop Duplication can report the pointer separately; exact cursor compositing in the helper has not been verified.
- The helper selects an Intel Arc adapter output matching the foreground window's monitor, waits for desktop updates, reports active/idle status, and verifies a pinned SHA-256 before launch. It does not use WGC and does not need a package manifest capability or capture-consent prompt.
- Runtime active, idle, and error changes are pushed back to the Graphics card while it is open, so the displayed status follows helper transitions instead of relying on the initial settings read.
- Crop textures, shader resource views, and the overlay render target view are now reused across frames and recreated when the size/format or device changes. Idle/non-game transitions release the overlay, duplication session, and device. The native helper is compiled with `/O2`. These reduce avoidable allocations and idle work; the remaining capture/composition cost and game FPS impact still need matched in-game measurements.

## Controlled tests

An artifact-only prototype previously verified B580 monitor capture, shader output differences at 100%, click-through behavior, and capture exclusion. With diagnostic full-frame readback on every frame, an animated 60-frame fixture delivered 45.6 capture frames per second, with 11.6 ms median capture-to-present submission time and 16.3 ms p95. Those measurements are not from the final bundled helper and should not be treated as product performance.

The final bundled helper has passed command parsing and clean-stop smoke checks, and the focused renderer check exercises active/idle/error status updates. The separate B580 Desktop Duplication probe verified capture exclusion, but the integrated helper has not yet passed a controlled visible-window test. No actual-game compatibility or image-quality result is claimed. The user plans to test Expedition 33 after receiving a Portable build.

## IGCL display-output sharpness lead

Intel's public IGCL API exposes `ctlGetSharpnessCaps`, `ctlGetCurrentSharpness`, and `ctlSetCurrentSharpness` for a display output. The observed B580 output advertises a non-adaptive intensity range of 1–5, step 1, and a reported default of 0. This may offer a driver-level whole-output effect without game-folder files, but the documented range excludes 0, off/default semantics are unclear, and no visual effect has been measured. It cannot provide per-game behavior on its own. A setting read-back would not prove that the panel visibly changed.

Because this is only five coarse levels and has unresolved enable semantics, Arc Power does not currently write this control. A reversible test would need to save the exact current tuple, target one uniquely identified physical output, try only advertised values, compare the physical display, and restore/read back the exact saved tuple.

## Licensing and provenance

The active sharpening shader is authored in the native helper source by Arc Power; no ReShade binary, setup program, third-party shader, or game hook is included in this implementation. The old ReShade sample-build provenance remains in repository history and its prototype files are excluded from packaged builds.

## Primary references

- [Intel IGCL Control API](https://intel.github.io/drivers.gpu.control-library/Control/api.html)
- [Intel public IGCL header](https://github.com/intel/drivers.gpu.control-library/blob/master/include/igcl_api.h)
- [Intel notice on removal of legacy IGS game effects](https://www.intel.com/content/www/us/en/support/articles/000100477/graphics.html)
- [Microsoft: Layered windows and mouse input](https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features)
- [Microsoft: DPI awareness](https://learn.microsoft.com/en-us/windows/win32/hidpi/setting-the-default-dpi-awareness-for-a-process)
