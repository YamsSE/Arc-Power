# IGCL feature audit and sharpening test build

Observed on October 15, 2026: Intel Arc B580, driver **32.0.101.9150**, active MSI G27C4 E3 output. The installed IGS assemblies identify as **26.36.2702.2**.

Two native libraries were queried in separate processes, without changing settings during the capability audit:

- Current driver-store `IntelControlLib.dll`, file version **1.3.306.0**.
- Arc Power's bundled `src/main/backend/igcl2023/IntelControlLib.dll`, version **1.0.100**.

An advertised capability establishes an API surface, not a visible IGS control or a working image effect. The audit does not claim that every API absent from Arc Power is hidden in IGS. Intel explicitly documents removal of game sharpening, adaptive tessellation, and anisotropic filtering; other IGS UI omissions remain unconfirmed.

## Gaming/3D capabilities

| ID | Feature | Current library | 2023 library | Interpretation |
|---|---|---|---|---|
| 0 | Frame pacing | Absent | Absent | No separate control advertised here. |
| 1 | Endurance Gaming | Absent | Custom; not per-app | Legacy metadata; Arc Power already gates this feature by platform. |
| 2 | Frame limit | Integer 30–300, step 1, default 60 | Absent | Already exposed by Arc Power. |
| 3 | Anisotropic filtering | Absent | Absent | Header declaration; no reported support on this setup. |
| 4 | CMAA | Enum, options mask 0 | Enum, options mask 0 | Candidate only; no selectable options advertised. |
| 5 | Texture filtering quality | Absent | Absent | No reported support. |
| 6 | Adaptive tessellation | Absent | Absent | No reported support. |
| 7 | Game sharpening | Absent; direct get unsupported | **Integer 0–100, step 1, default 0; per-app** | Legacy driver route; writes/read-back succeeded but produced no visible change in the user's DX11/DX12 tests. No live-change flag. |
| 8 | MSAA override | Absent | Absent | No reported support. |
| 9 | Gaming flip modes | Enum mask 0x6f | Enum mask 0x6f | Already exposed by Arc Power. |
| 10 | Adaptive Sync Plus | Absent | Absent | No reported support under this feature ID. |
| 11 | Application profiles | Custom, per-app | Custom, per-app | Compatibility/profile plumbing, not a newly proven effect. |
| 12 | Application profile details | Absent | Absent | No reported support. |
| 13 | Emulated typed 64-bit atomics | Enum, options mask 0 | Absent | Compatibility candidate; no user choices or effect established. |
| 14 | Windowed-BLT VRR | Enum mask 0x7 | Absent | Already used by Arc Power's global VRR mode. |
| 15 | Global/per-app selector | Enum | Absent | Already used by Arc Power for game profile scope. |
| 16 | Low latency | Enum mask 0x3 | Absent | Already exposed by Arc Power. |
| 17 | Frame generation | Enum | Absent | Already exposed by Arc Power with game eligibility checks. |
| 18 | Prebuilt shader download | Boolean, adapter scope | Absent | Already exposed by Arc Power on eligible hardware. |
| 19 | Live state | Custom, per-app | Absent | Diagnostic/state query; not an independently proven toggle. |

## Additional advertised control families

Both libraries returned the same seven video-processing capabilities. These concern applications using the driver's video-processing interfaces; they must not be presented as game filters.

| Video feature | Reported payload / range |
|---|---|
| Film mode detection | Boolean, default enabled |
| Noise reduction | Custom payload, 96 bytes |
| Video sharpness | Unsigned integer 0–64, step 1, default 44; default disabled |
| Adaptive contrast enhancement | Custom payload, 96 bytes |
| Standard color correction | Custom payload, 152 bytes |
| Total color correction | Custom payload, 192 bytes |
| Skin tone enhancement | Unsigned integer 0–9, step 1, default 3; default enabled |

Video super resolution (feature 4) was absent from both tables. Intel's API documentation says it requires application activation through Intel.

Both libraries also advertised **display-output sharpness** on the active monitor: one non-adaptive filter with intensity range **1–5**, step 1, reported default 0. This is a separate per-output display API, not game sharpening. Its default lies outside the reported active range; default/disabled semantics and actual output behavior need validation before implementation. Inactive/virtual outputs returned a KMD-call error. No display-sharpness or video-processing settings were written in this audit.

Advanced display LUT/matrix transformations are declared in public IGCL. This audit did not establish usable advanced pipeline blocks. Arc Power already represents basic pixel-transformation color controls, so those are not newly discovered controls.

## Sharpening implementation and verification boundary

The original Intel 3D feature ID is **7** with an `INT32` enable/value payload. Current IGCL rejects it, while the bundled older library advertises its complete 0–100 range. On the tested B580, writes and read-back succeeded, but the user reported no visible change in Expedition 33 (DX12) or Palworld (DX11) after fully relaunching the game. This confirms that accepting a value is not enough to establish an image effect.

Arc Power's current replacement test path is described in [the sharpening render-path investigation](sharpening-render-path-2026-10-16.md). It uses DXGI Desktop Duplication to capture the composed output on an Intel Arc-connected monitor, crop the foreground window, and composite an Arc Power-authored shader without game-folder changes, API injection, or a downloaded setup. Its controls are integer **0–100%** sliders in **Graphics → General** and **Game Profile → Graphics**. The global switch gates both global and per-game values. The separate B580 probe verified that the test overlay was excluded from Desktop Duplication on that display. A controlled visible-window test of the integrated helper and compatibility with actual games/APIs remain pending; no game-rendering support is claimed yet. Vulkan and pointer compositing are not verified, and rotated/mismatched outputs currently fail closed.

The separate per-output IGCL sharpness capability is a possible driver-backed global mode, but it advertises only 1–5 intensity, reports default 0 outside that range, and its visible effect has not been established. It is not currently written by Arc Power. See the render-path document for the safe test conditions and limitations.

## Primary references

- [Intel IGCL API and structures](https://intel.github.io/drivers.gpu.control-library/Control/api.html)
- [Intel public header](https://github.com/intel/drivers.gpu.control-library/blob/master/include/igcl_api.h)
- [Intel video-processing programming guide](https://intel.github.io/drivers.gpu.control-library/Control/PROG_media.html)
- [Intel notice of IGS feature removal](https://www.intel.com/content/www/us/en/support/articles/000100477/graphics.html)
