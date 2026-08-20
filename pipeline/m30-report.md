# M30 verification report

Date: 2026-08-20

## Scope

M30 completes vendor-neutral multi-GPU inventory and selection, stable physical identity routing, selected-device telemetry handover, and Dashboard/Tuning parity. The final review finding was the DXGI same-model adapter bridge: PCI device-id-only LUID selection was replaced with a D3DKMT LUID -> adapter handle -> `KMTQAITYPE_ADAPTERADDRESS` BDF lookup, with fail-closed behavior when the bridge is unavailable.

## Review

- M30 step-4 findings were folded into the working tree.
- Final review was closed after the required findings were fixed and focused verification passed; no additional review round was run.

## Source changes

- Added unified GPU inventory rows for IGCL and Windows OS controllers, preserving PNP-first identity and stable BDF fallbacks.
- Added explicit resolved-target routing and stale/ambiguous physical-target refusal across in-process and elevated apply paths.
- Added vendor telemetry mapping for AMD ADL and NVIDIA NVML, including same-vendor reorder handling and selected-device ownership cleanup.
- Switched Dashboard and Tuning to the shared vendor-neutral selector; unsupported GPUs retain telemetry/readouts while showing no fake OC controls.
- Added DXGI adapter BDF resolution through the documented D3DKMT bridge and threaded BDF into the sys-stats LUID lookup.

## Checks

- `npx tsc --noEmit`: passed.
- `npm run build:renderer`: passed; app, overlay, and advanced-overlay bundles rebuilt.
- Explicit complete JavaScript test set (`node --test --test-timeout=30000 test/*.test.js`): **1571 passed, 0 failed, 0 cancelled**.
- Focused M30 regression batch (inventory, vendor telemetry, sys-stats, IPC, DXGI): **319 passed, 0 failed**.
- `RID_MOCK_MULTI_DEVICE=1 RID_MOCK_MULTI_ARC=1 npx electron . --ui-verify`: **UI VERIFY OK**; mixed A770/A750 Dashboard and Tuning selectors matched.
- `RID_MOCK_NO_INTEL=1 RID_MOCK_VENDOR=nvml npx electron . --ui-verify`: **UI VERIFY OK (synthetic-os-nvml)**; read-only NVIDIA inventory/Tuning state passed.
- `npm test` was attempted but its unbounded `node --test` discovery did not settle after five minutes and was cancelled; the explicit full JS test set above completed cleanly.

## Distribution

- `npm run dist`: renderer build, unpacked packaging, portable target, and NSIS target completed. Artifacts produced:
  - `dist/Arc-Power_Portable.exe`
  - `dist/Arc-Power_Installer.exe`
- The command returned exit 1 only at electron-builder's publish step because `GH_TOKEN`/GitHub PAT is unset (known non-fatal publish failure).
- Packaged headless smoke: **EXITCODE=0** using `dist/Arc-Power_Portable.exe --headless`.
