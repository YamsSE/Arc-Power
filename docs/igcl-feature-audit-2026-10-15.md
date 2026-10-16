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
| 7 | Game sharpening | Absent; direct get unsupported | **Integer 0–100, step 1, default 0; per-app** | Legacy route used by this change. No live-change flag: restart the game after changes. |
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

The original Intel 3D feature ID is **7** with an `INT32` enable/value payload. Current IGCL rejects it, while the bundled older library advertises its complete 0–100 range. An isolated helper keeps the legacy graphics context separate from Arc Power's overclocking runtime. It resolves the adapter by Windows LUID, validates values and application scope, and verifies native writes by read-back.

The UI has separate enable switches and **0–100% integer sliders** in **Graphics → General** and **Game Profile → Graphics**. An absent game-specific sharpening field preserves inheritance from global settings. Enabling a game assignment selects the driver's per-application scope; disabling the assignment restores the global scope.

A live test through Arc Power's backend and isolated helper set global sharpening to enabled/23 and a disposable game override to enabled/73. Both passed immediate and delayed native read-back; the game override left the global value at 23. The test then restored global sharpening to disabled/0, set the disposable override to disabled/0, and returned that game's profile scope to global inheritance. This does not prove that the initially absent override record was deleted. An earlier direct native probe also accepted and returned enabled/37. These checks prove control-state persistence, not rendered-image processing.

Focused validation passed 71 automated tests, TypeScript checking, and a real Chromium UI run using the mock backend. The UI run covered integer percent sliders, enable-state preservation, applying and reopening settings, inherited global values without creating an override, and per-GPU stored assignments. Packaged validation is recorded separately in the distributable build report.

The user will perform the final visual comparison in **Clair Obscur: Expedition 33**. Restart the game between disabled and enabled comparisons; use a fixed scene and camera, leave other graphics settings unchanged, and compare disabled against a high sharpening level before choosing a preferred strength. This build does not claim that modern drivers reproduce the old IGS filter until that comparison succeeds. A-series hardware has not been tested in this investigation.

## Primary references

- [Intel IGCL API and structures](https://intel.github.io/drivers.gpu.control-library/Control/api.html)
- [Intel public header](https://github.com/intel/drivers.gpu.control-library/blob/master/include/igcl_api.h)
- [Intel video-processing programming guide](https://intel.github.io/drivers.gpu.control-library/Control/PROG_media.html)
- [Intel notice of IGS feature removal](https://www.intel.com/content/www/us/en/support/articles/000100477/graphics.html)
