# Game sharpening: rendering follow-up, 16 October 2026

## Native Intel result

The legacy IGCL 1.0.100 library advertises feature ID 7 as an integer 0–100 sharpening setting, with DX9/DX11 flags and per-application support. Writes and read-back succeed on this B580, but that does not establish an image effect. The user saw no change in Expedition 33 (DX12) or Palworld (DX11, global 100%, fully relaunched). The current IGCL 1.3.306.0 does not advertise the feature on driver 32.0.101.9150.

Intel's [support notice](https://www.intel.com/content/www/us/en/support/articles/000100477/graphics.html) describes sharpening having no visible effect and its removal from newer Graphics Software. No documented activation switch was found. The previous native controls are no longer offered in the normal UI; backend diagnostics remain available. This implementation does not claim to restore Intel's original filter.

## Replacement

Arc Power supplies its own adaptive unsharp-mask shader and a pinned, modified source build of ReShade 6.8.0. The runtime and shader are included with the application. Setup does not download or execute an external installer. The managed runtime has no overlay or add-ons, does not save over Arc Power's owned configuration/preset, and skips ReShade's update check.

- Graphics → Image Sharpening sets the global default, using an integer 0–100% slider.
- Profiles → selected game's Graphics → Image Sharpening sets up the game and supplies a per-game override, or inherits the global value.
- Global settings apply only to games explicitly set up through these controls.
- The setting is shared across GPUs. It uses its own Apply control independently of driver Graphics settings and the GPU tuning profile toggle.
- Restart the game after setup or a setting change. The game must be closed during setup/removal.
- Select the executable that renders the game, rather than a launcher. For Palworld this is `Palworld-Win64-Shipping.exe`.

The initial validated setup supports **64-bit DirectX 11 and DirectX 12** on Windows 10/11. DX9, DX10, OpenGL and Vulkan are requested follow-up work under the same controls; their setup paths and rendered behavior are not yet validated or offered as supported. Vulkan needs its own layer installation/removal.

## Existing modifications and removal

A free game directory receives an owned `dxgi.dll`, `ReShade.ini`, and `ArcPowerSharpening` shader/preset directory. If an existing proxy is positively identified as OptiScaler, it is preserved: the runtime is installed as `ReShade64.dll`, and only `[Plugins] LoadReshade` is enabled in the existing OptiScaler configuration. Unrecognized proxies/configuration conflicts are refused.

The service records ownership and hashes, checks paths/links before writes, and refuses to overwrite changed managed files. Removal restores the original OptiScaler configuration if it still matches the managed copy. Existing user mods are not replaced. No actual game directory was changed during the automated probes.

## Rendering evidence

Tests use native DX11 and DX12 sample programs selecting the physical Intel Arc B580. GPU backbuffers are read after the runtime's Present processing. These are controlled rendering samples, not screenshots from Expedition 33 or Palworld.

The full service installs its bundled runtime and shader, applies disabled, 0%, 50%, 100%, and per-game 0% over global 100%, then removes its files. In both APIs:

- Disabled, enabled 0%, and per-game 0% yield identical image data.
- 50% and 100% change pixels; 100% increases the measured image difference over 50%.
- Edge energy increases with sharpening.
- Owned config, preset and shader hashes remain unchanged after the samples exit.
- Removal succeeds.

The same 0%/100% comparison also passed through a disposable copy of the user's OptiScaler proxy on DX11 and DX12. Removal restored that copy's proxy hash and configuration bytes exactly. The source Palworld files were read and copied only; this does not prove compatibility inside Palworld itself.

Focused tests cover service security/rollback, global inheritance and overrides, IPC validation/catalog authorization, existing graphics routing and game profiles. An Electron/Chromium test exercises the actual global and per-game controls and verifies they issue no legacy IGCL sharpening writes. Typechecking and renderer compilation pass. Full-suite status is not inferred from these focused checks.

Not yet established: rendering in the user's actual games, HDR output, 32-bit games, other graphics APIs, every third-party mod combination, or games that block injected runtimes.

## Licensing and provenance

ReShade's [BSD 3-clause source licence](https://github.com/crosire/reshade/blob/v6.8.0/LICENSE.md) explicitly permits modified source/binary redistribution with notices and without implied endorsement. The package includes that licence, dependency notices, source commit/submodule identities, the local patch and rebuild instructions in `src/main/sharpening-runtime/`. Arc Power's shader is newly authored under the application's GPL-2.0-only licence; no third-party sharpening shader pack is included. The ReShade runtime runs in the game process and retains its separate licensing.

The custom build excludes the Microsoft D3D12On7 component, whose redistribution terms are narrower, and excludes the GUI's embedded font. Standard Windows 10/11 DX12 remains compiled and passes the rendering probe.

ReShade's [website](https://reshade.me/) separately asks users not to redistribute binaries/shaders. Our modified source-build approach relies on the explicit source licence; it is not a claim of upstream endorsement or legal advice. The official downloaded setup binary is not included in the product.

## Reproducing focused checks

```text
npm run typecheck
npm run build:renderer
node --test test/sharpening-proxy.test.js test/sharpening-contract.test.js test/sharpening-postprocess.test.js test/postprocess-sharpening-ipc.test.js test/graphics-rtss.test.js test/game-profile-rtss.test.js test/apply-worker-game-profile.test.js
npx electron test/postprocess-sharpening-ui-runner.mjs
```

Build the two controlled sample programs using `test/native-sharpening-probe/build.cmd` and `build-dx12.cmd`, placing their output in `.codex/task-artifacts/sharpening-render-proof/`, then explicitly run `node test/sharpening-render-proof.mjs`. The optional `test/sharpening-optiscaler-proof.mjs` reads the locally installed Palworld proxy to create owned copies; it does not redistribute that proxy. The render tests create owned temporary directories and retain their JSON/image results there.
