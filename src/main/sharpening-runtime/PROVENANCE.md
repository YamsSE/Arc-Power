# ReShade 6.8.0 source-built managed runtime

## Source provenance

- Upstream: https://github.com/crosire/reshade.git
- Tag: `v6.8.0`
- Commit: `18deaa52de0c425a78b329e9cb3c497281cd00ec`
- Submodule SHAs: `SUBMODULE-SHAs.txt`
- ReShade and dependency license texts: `third-party-notices/`

## Build variant

This is a locally rebuilt, x64 managed runtime for Arc Power's own preset/effect controls. Release has `RESHADE_ADDON=0`, no ReShade GUI/localization, and defines `ARC_POWER_MANAGED=1`. The managed macro makes ReShade's `save_config` and `save_current_preset` no-ops so the owned configuration and preset do not get rewritten, and skips ReShade's automatic update check so the runtime does not make an update request. Upstream D3D12On7 props, implementation units, wrappers, and interface paths are excluded; standard DX12 remains compiled. The two upstream example built-in add-ons are excluded. This variant is for the Arc Power Windows 10/11 app path and does not include the D3D12On7/Windows 7 route.

The controlled variant adds a same-user, same-session per-process named pipe.
Its setting is read on the game's render thread, where it changes only the
`ArcPowerSharpen` technique and its 0–100 strength uniform. It performs no
desktop capture or independent overlay presentation. The separate ASR helper
continues to own thumbnail scaling and input topology.

These modifications are recorded in `source-build-local.patch`; the build helper applies it to a clean checkout pinned at the commit above.

## Rebuild

1. From the worktree root, clone the pinned source into the default development artifact path:

   `git clone --depth 1 --branch v6.8.0 --recurse-submodules --shallow-submodules https://github.com/crosire/reshade.git .codex/task-artifacts/sharpening-render-proof/reshade-source`

2. Run `src/main/sharpening-runtime/build-source-runtime.ps1` from the worktree root in PowerShell. It applies the recorded patch, uses MSBuild Release|x64, v143, Windows SDK `10.0`, and copies the build as `src/main/sharpening-runtime/ArcPower.ReShade64.dll`.

The helper accepts `-SourceDir`, `-PythonDir`, and `-MSBuildPath` for alternate local tool/source locations. It also supports `-BuildOnly -SourceDir <path>` to copy an existing build without compiling; this mode requires the exact recorded patch to already be applied, verified with `git apply --reverse --check` and an exact comparison of the tracked working diff. Python packages and command shims are stored in the task-artifact `rebuild-tools` directory beside the source checkout, outside the packaged source tree.

The tested build used MSBuild `17.14.60`, MSVC `14.44.35207`, Windows SDK `10.0.26100`, and the bundled Python `3.12` runtime. The helper installs glad's pinned requirements into `rebuild-tools/python-site` beside the source checkout via `pip`; glad downloads Khronos XML companion headers during code generation, so a network connection is required for a clean build. No runtime installer binary was used. The rebuilt DLL has no `WININET.dll`, `InternetOpen`, or `InternetOpenUrl` imports.

## Current artifact

- `ArcPower.ReShade64.dll`: x64 Release; 3,774,464 bytes
- SHA-256: `EFC04FE58F8544A3AB839FC759A2382A3259708FED7B1F59FC5A84C0C6AD5759`
- Runtime integrity pins: `src/main/managed-sharpening-runtime.js`; update deliberately after rebuilding and validation.
- Build transcript: `build.log`
- Patch SHA-256: `841F4F0174DBD4321EEE3F57A351426E150E8CFB52BA4027AB4FBC209ACA8753`
- Build helper: `build-source-runtime.ps1`
