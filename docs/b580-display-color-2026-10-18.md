# B580 display color controls

## Confirmed faults

The wire-format binding inserted a four-byte pad that does not exist in Intel's public structure. The correct x64 layout is 92 bytes, with the supported array at offset 12 and current format at offset 76. A corrected read on the tested B580 reports RGB/8 bpc and YCbCr444/8 bpc. The previous 96-byte layout shifted the fields and incorrectly produced empty depth choices. The apply verifier also compared the native `YCBCR_444` name with the UI's `YCbCr444`; this is now canonicalized before comparison.

The old color implementation selected a matrix-and-offset block (type 4), put all four controls into that matrix, and required CURRENT reads that fail on this driver. The installed IGS wrapper instead discovers the output pipeline through CAPABILITY and applies hue/saturation to its type-3 matrix and brightness/contrast to its RGB type-1 LUT. Those are the paths implemented here. The old combined matrix implementation, including its incorrect hue coefficients, has been removed.

## State and UI contract

The driver accepts color writes but does not provide usable CURRENT readback for these controls on the tested system. Arc Power therefore keeps its desired settings separate from driver current state:

- Native capability `value` remains null. `desiredValue` and `lastSent` describe Arc Power's editor state.
- First application explicitly discloses that it replaces the corresponding IGS adjustments. The first Apply button says **Apply Arc Power settings** and supplies the replacement acknowledgement.
- The result reports `verification: readback-unavailable`; the UI says **Color settings sent** and **Last sent**, without claiming hardware readback.
- Hue/saturation and brightness/contrast are separate groups, so editing one scalar preserves its paired Arc Power value and leaves the other transform block alone.
- Versioned records are keyed by native PCI/BDF plus encoder/EDID identity when available. This remains consistent across different public adapter aliases in the main and elevated processes.
- Stored settings are read on refresh; they are not automatically reapplied on startup. Changes made in IGS are not reflected in Arc Power's saved values.
- Corrupt, oversized, or linked state records fail closed. Saves are atomic. An edit made during an in-flight Apply remains staged.

The native implementation uses capability-selected block IDs, owned buffers that remain alive through synchronous calls, and bounded sample/block counts. Ambiguous transform blocks or unsupported nonuniform LUTs remain unavailable. Restores used by diagnostics target explicit block IDs and never restore the entire pipeline.

## Live B580 evidence

Tested physical adapter: Intel Arc B580, PCI device `e20b`, BDF `3:0.0`. Display: MSI G27C4 E3 on DisplayPort, 1920×1080 at approximately 180 Hz. IGS package version inspected: 26.36.2702.2. The user confirmed that all IGS color controls were initially at defaults.

1. Corrected wire-format GET returned RGB/8 bpc, with RGB/8 and YCbCr444/8 advertised. Other depths were not advertised at this output mode.
2. RGB/8 → YCbCr444/8 → RGB/8 passed native readback.
3. Quantization Default → Limited → Full → Default passed native readback.
4. Hue 45°, grayscale saturation, brightness at UI 70%, and contrast at UI 90% were accepted through the product backend. The user confirmed the changes were visible.
5. Each color test returned to neutral. A final restore of only the selected type-3 matrix and RGB LUT returned IGCL SUCCESS. The user confirmed the display returned to normal. No claim of native color-value readback is made.

Live probes used an isolated color-state directory and an independently armed rollback process. The product's saved color settings were not populated by the probes. No unrelated display, GPU tuning, EDID, or registry settings were changed by these display tests.

Local evidence is retained under `.codex/task-artifacts/b580-display-color/`, including raw read probes, wire/quantization round trips, the color round trip, and UI screenshots. Installed IGS code was inspected read-only; no IGS binary or decompiled method body is included in the product.

## Validation scope

Focused tests cover the wire ABI and captured response, color matrix/LUT math and selected-block writes, rejection of unsupported LUT layouts during discovery, persistence and corrupt-state handling, managed-versus-native UI values, first-use acknowledgement, target identity, cross-process-equivalent alias persistence, and retaining newer edits during Apply. The rendered Electron check also covers two-display selection and switching between Graphics and Display during a pending Apply. It uses isolated mock state; the B580 visual test is separate real-hardware evidence. Other adapters, monitors, HDR modes, and color-depth combinations have not been live validated by this task.

## Primary API references

- [Intel IGCL public header](https://github.com/intel/drivers.gpu.control-library/blob/master/include/igcl_api.h): wire-format structures, pixel transformation block types, CAPABILITY/CURRENT queries, and one-block SET operations.
- [Intel IGCL Control API](https://intel.github.io/drivers.gpu.control-library/Control/api.html): display-output wire format and pixel transformation contracts.
