# Rust backend migration inventory

Status: migration in progress. The current Tauri application remains Electron-backed. No full native backend parity or RAM reduction is claimed. Inventory baseline: 2026-11-07; native storage integration and B580 read-only probe verified 2026-11-08. This is a historical scope inventory, not a current channel-ownership map: implementation has advanced since the baseline. Use `docs/tauri-migration.md` and the current source for present ownership and acceptance gates.

At the inventory baseline, the Tauri application used Rust for profile/settings persistence, migrations, all 45 settings read fields, settings write/cache normalization and Arc Sleep-owned storage state. Its compatibility handlers retained input validation and product reactions, and delegated storage through eight fixed private methods. Paths were selected by the native host, not request payloads. Standalone legacy Electron and boot-worker modes still used their existing store. `app-version` also dispatched directly to Rust. At that baseline, native VF logic, window placement, memory counters and the Arc Sleep policy were implemented but not yet substituted into their production control paths; subsequent migration work supersedes that status.

`node scripts/verify-electron-free.mjs <extracted-payload> <known-electron.exe>` checks payload markers, retained compatibility directories, Node addons and copies of the reference runtime even under another executable name. It correctly rejects the existing transitional payload. This is one dependency check, not the complete acceptance criteria below.

Native settings tests use 297 read and 300 write/cache golden cases shared with `scripts/rust-settings-parity.test.mjs`. Arc Sleep policy testing compares 3,500 transitions against the original JavaScript. These checks do not read or write live application data. Storage callers share one `Arc<SchemaStore>` per root: its mutex is per instance, and path-based reparse rejection is not a guarantee against hostile concurrent path replacement. Malformed legacy string profiles containing surrogate pairs are refused rather than silently changed. Private storage requests are bounded, authenticated and never automatically retried after uncertain outcomes.

Integration validation: 74 backend tests, 26 host tests and three read-only example tests pass, with one subprocess helper intentionally ignored as a standalone test. The focused Node suite passed 41 checks; the added write/cache golden check also passes. Actual WebView2 mock workflows verified all ten pages, native HUD/panel permissions, Rust-backed profile CRUD, settings persistence, synchronous close-to-tray caching and native host exit after normal close. Environment-only `RID_BACKEND=mock` selection was tested with a temporary canary APPDATA and shared isolated mock root; the canary remained untouched. Unit tests cover tagged negative zero and undefined policy options.

The standalone native read-only example initialized IntelControlLib from the active B580 package (driver 32.0.101.9175, published INF oem59.inf), enumerated the B580 and explicitly closed successfully. The example started no Electron process and bound no waiver/fan/OC setter. Its single-process memory measurement is not a whole-application RAM comparison. Normal packaged Portable startup, full native feature parity and Electron-free distributions remain unverified; no GPU tuning writes were performed.

## Current execution path

The WebView2 renderer invokes the Tauri bridge in src-tauri/src/main.rs. Rust transports requests over a private authenticated named pipe to src/main/tauri-broker.js and src/main/tauri-service-mode.js. The service dispatches the existing src/main/ipc.js / src/main/ipc-core.js handlers and JavaScript services, native Koffi bindings, and external helpers. src-tauri/src/runtime.rs:16-23 resolves development node_modules/electron/dist/electron.exe or the packaged compatibility-backend executable and resources/app.asar. Renaming that executable ArcPower.Backend.exe does not remove Electron.

The six roles are main, overlay, advanced-overlay, recording-toast, recording-status-pill, and splash. The generated contract has 153 main invocation names, two additional splash invocation names, and 21 unique push event names. Installer IPC is a separate surface. All command groups below are disjoint. Counts describe API coverage, not implementation effort. The command and native-API inventories below describe the original proposed scope; do not interpret their “Port” wording as proof that a feature remains unported.

## Command accounting: 155 application commands

### Hardware control and identity (28)

Port ipc-core validation, unified GPU identity/enumeration, IGCL and Sysman adapters, apply routing/transactions, waiver and mode state, fan resume, graphics/display policies, Arc Sleep, reset and read-back semantics. Highest risk: incorrect GPU target, ABI/units, stale identity, unsafe writes, and loss of driver refusal/read-back checks.

- `advanced-mode-accepted-get`
- `advanced-mode-accepted-set`
- `apply-settings`
- `arc-sleep-base-cap-get`
- `arc-sleep-state-get`
- `device-get`
- `device-preferred-get`
- `device-selection-generation-get`
- `device-selection-push`
- `device-selection-request`
- `device-set`
- `display:apply`
- `display:get`
- `fan-resume:get`
- `fan-resume:set`
- `get-capabilities`
- `get-current-settings`
- `graphics:apply`
- `graphics:get`
- `health`
- `list-devices`
- `oc-mode-get`
- `oc-mode-set`
- `power-limits:read`
- `reset-to-defaults`
- `voltage-offset:read`
- `waiver-accept`
- `waiver-get`

### Overlays and layouts (12)

Original scope: overlay/layout state, telemetry subscriptions and multi-device lanes. Preserve native-window positioning, scale, hotkeys, visibility, click-through, focus, close/hide semantics, and cross-window synchronization. Native host windows alone do not provide these services. Current implementation ownership and remaining gates are tracked in `docs/tauri-migration.md`.

- `advanced-overlay:close`
- `advanced-overlay:get-state`
- `advanced-overlay:toggle`
- `overlay-layout-delete`
- `overlay-layout-rename`
- `overlay-layout-save`
- `overlay-layout-select`
- `overlay-layouts-list`
- `overlay-resize`
- `overlay-telemetry-start`
- `overlay:get-state`
- `overlay:toggle`

### Shell, startup, registry and lifecycle (17)

Port app metadata/elevation, user paths, single-instance behavior, startup/task registration, boot apply, registry catalog/apply/rollback, tray actions, window lifecycle, cache maintenance and relaunch teardown. Installer and background launch modes also require native handling.
In normal non-mock runs the Tauri bridge directly handles `window-minimize`, `window-maximize-toggle`, and read-only `registry-catalog` from shared descriptors; `window-close` and `registry-apply` remain with the compatibility close-to-tray and elevated-write paths. Mock registry reads and writes stay together in Electron because they share mutable state.

- `app-elevated`
- `app-version`
- `app:build-info`
- `app:clear-cache-restart`
- `app:maintenance-restart`
- `boot-apply-outcome`
- `open-external`
- `registry-apply`
- `registry-catalog`
- `rtssStartupGet`
- `rtssStartupSet`
- `startup-get`
- `startup-set`
- `tray-rebuild`
- `window-close`
- `window-maximize-toggle`
- `window-minimize`

### Screen post-processing: Sharpening and Arc Super Resolution (8)

This is the separate screen post-processing Arc Super Resolution feature; it is unrelated to the removed Display Super Resolution option. Port sharpening-screen orchestration and validation, target picker, global hotkey, settings/status, start/countdown/active cancellation, native process lifecycle, ASR options and safe target selection. Reuse native capture/scale/present helpers where currently wired; retain real game behavior and cursor/input constraints.

- `arc-super-resolution:get`
- `arc-super-resolution:set`
- `postprocess-sharpening:get`
- `postprocess-sharpening:hotkey-get`
- `postprocess-sharpening:hotkey-set`
- `postprocess-sharpening:select-window`
- `postprocess-sharpening:set`
- `postprocess-sharpening:stop-window`

### Driver management (12)

Port catalog/release retrieval, update detection/monitoring, downloads with progress, cancellation/deletion and verified install handoff. Retain URL/path/hash validation and available-versus-installed distinction.

- `driver-info`
- `driver-monitor-check`
- `driver-monitor-status`
- `intel-driver-download-cancel`
- `intel-driver-download-delete`
- `intel-driver-download-page-open`
- `intel-driver-download-start`
- `intel-driver-download-status`
- `intel-driver-install`
- `intel-driver-library`
- `intel-driver-release`
- `intel-driver-update-check`

### Telemetry and system information (7)

Port telemetry scheduling/coalescing, IGCL/vendor/OS aggregation, RTSS FPS/shared-memory lanes, DXGI fallback, D3DKMT, CPU/MSR/LHM metrics, system info and monitoring log. Preserve timestamps/units/null degradation and polling shutdown.

- `fps-poll`
- `monitor-log-append`
- `sysinfo:get`
- `telemetry-latest`
- `telemetry-start`
- `telemetry-stop`
- `vendor-info:get`

### Game library and per-game profiles (10)

Port safe executable selection/scanning, catalog/artwork persistence, independent OC association and per-game graphics records, capability checks, physical target revalidation and game launch/apply policies.

- `game-catalog-add`
- `game-catalog-list`
- `game-catalog-sync`
- `game-profile-capabilities`
- `game-profile-delete`
- `game-profile-save`
- `game-profiles-list`
- `game-settings-delete`
- `game-settings-save`
- `games-scan`

### Mock and diagnostic flows (4)

Provide equivalent deterministic fixtures and boot-apply diagnostic logs. These are parity/test coverage requirements; mock success cannot establish real hardware parity.

- `mock:boot-apply-log`
- `mock:list-featuresets`
- `mock:run-boot-apply`
- `mock:set-featureset`

### OC profiles and persisted settings (7)

Port schema migrations, per-device OC mode, VF stock/baseline/reference intent, profile save/rename/delete/import/export, settings normalization, atomic persistence and concurrent save behavior. Preserve existing user data paths and formats or provide an explicit migration.

- `profiles-delete`
- `profiles-export`
- `profiles-import`
- `profiles-list`
- `profiles-rename`
- `profiles-save`
- `profiles-settings-save`

### Recording, replay and editor (30)

Port Ascent stdio protocol, process/capture inventory, runtime lease/probe/idle handling, recording/replay state machines, encoder/GPU selection, audio routing, clips/markers/storage, bounded replay trimming/finalization, media serving, thumbnails, editor/progress/cancel, copy/share/folder actions, hotkeys/toasts/status pill and shutdown.

- `recording-auto-start`
- `recording-capture-targets`
- `recording-choose-folder`
- `recording-clip-copy`
- `recording-clip-delete`
- `recording-clip-save`
- `recording-clip-url`
- `recording-clips-list`
- `recording-editor-audio`
- `recording-editor-cancel`
- `recording-editor-copy`
- `recording-editor-folder`
- `recording-editor-open`
- `recording-editor-share`
- `recording-editor-start`
- `recording-editor-status`
- `recording-marker-add`
- `recording-markers-list`
- `recording-open-folder`
- `recording-processes-list`
- `recording-replay-start`
- `recording-runtime-acquire`
- `recording-runtime-probe`
- `recording-runtime-release`
- `recording-settings-get`
- `recording-settings-save`
- `recording-start`
- `recording-status`
- `recording-stop`
- `recording-storage-info`

### Stability lab (5)

Port stability controller/report storage, exact-target D3D11 GPU workload, telemetry/report association, WHEA monitoring, cancellation and release of GPU resources. This workload is JavaScript/Koffi and is not supplied by the external recording or sharpening executables.

- `stability-report-latest`
- `stability-reports-list`
- `stability-run-cancel`
- `stability-run-start`
- `stability-run-status`

### OBS streaming (10)

Port OBS WebSocket challenge authentication, requests/timeouts/reconnect/disconnect, scenes, stream state, microphone mute, duck/restore behavior and encrypted credentials. Existing safeStorage credential use needs an explicit Windows-compatible decrypt/migration strategy.

- `stream-connect`
- `stream-disconnect`
- `stream-duck`
- `stream-duck-restore`
- `stream-microphone-mute`
- `stream-scene-set`
- `stream-scenes`
- `stream-start`
- `stream-status`
- `stream-stop`

### Application updates (3)

Port release checking, authenticated asset selection/hash verification, progress/cancel/failure handling, installed versus portable replacement and native installer/relaunch handoff.

- `update:check`
- `update:download`
- `update:install`

### Splash update flow (2)

Preserve startup update decision, install handoff, readiness phases, splash close blocking and visible error/status events.

- `splash:update-now`
- `splash:update-choice`

## Separate installer contract

The Electron preload src/installer/installer-preload.cjs exposes five commands: `installer:state`, `installer:choose-directory`, `installer:install`, `installer:uninstall`, and `installer:close`; it subscribes to `installer:progress`. These are outside the 155 application commands. Port src/main/installer.js and installer-pure.js behavior: directory selection, payload copy, install/repair, native-host registration, Start Menu/desktop shortcuts and icon invalidation, uninstall registry entries, optional RTSS installation, privilege boundaries, launch-after-install and uninstall helper handshake. Existing installer window and executable wrappers cannot remain Electron-based in a fully Electron-free deliverable.

## Push events and role authority

Retain all 21 generated event names and their role-specific authorization; do not turn every window into an unrestricted main-window dispatcher.

- `advanced-overlay:settings`
- `device-selection:request`
- `device-selection:updated`
- `device:state-updated`
- `fan-resume:status`
- `graphics:state-updated`
- `intel-driver-download:progress`
- `oc-mode:updated`
- `overlay:settings`
- `postprocess-global-settings:updated`
- `postprocess-sharpening:status`
- `recording:action`
- `recording:notification`
- `recording:pill-settings`
- `recording:settings`
- `recording:state`
- `splash:update-status`
- `stability:status`
- `telemetry:sample`
- `update:download-progress`
- `window:maximized-changed`


## Native APIs and reusable assets

At the inventory baseline these were reusable native boundaries rather than completed Rust ports. Implementation has advanced since then, so this table is a dependency and risk reference, not a current status map. See `docs/tauri-migration.md` and the current source for ownership and remaining gates. Static binding inventories contain 67 `ctl*` bindings in backend/igcl-bindings.js and 34 `ze*`/`zes*` bindings in sysman/sysman-bindings.js; missing exports currently degrade through optional binding logic and must remain optional.

| Boundary | Existing source/assets | Migration treatment and risk |
| --- | --- | --- |
| Intel IGCL | backend/igcl-bindings.js, igcl-backend.js, igcl-display-color.js, igcl-display-scaling.js; driver IntelControlLib.dll | Rust FFI can call the same runtime. Preserve explicit struct sizes/offsets, raw version-specific buffers, canonical W/V/MHz/GTS conversions, runtime discovery, capability checks and read-back. High risk. |
| Legacy IGCL | old-igcl.js; backend/igcl2023/IntelControlLib.dll | Preserve the isolated legacy control route and its target/capability rules. The DLL is reusable; old-igcl.js is not a standalone native service. High risk. |
| Intel Level Zero Sysman | sysman/sysman-bindings.js, power-limits.js; driver ze_loader.dll | Rust FFI for standalone zes initialization, PCI matching, OC domains, VF controls, voltage offset and sustained/burst/peak power. Preserve helper isolation, recovery and verified physical target mapping. High risk. |
| NVIDIA / AMD telemetry | vendor-telemetry/nvml.js, adl.js, vendor-telemetry.js; driver nvml.dll / atiadlxx.dll | Reuse DLLs with Rust bindings, preserve exact-device identity and read-only degradation. Medium/high risk. |
| Windows graphics / processes | fps-dxgi.js, d3dkmt-gpu-util.js, foreground-api.js, memory-util.js, backend/windows-display-mode.js, gpu-read-only-diagnostics.js, apm-capture.js | Replace Koffi with Windows FFI/COM for DXGI/D3D11, GDI/D3DKMT, User32/Kernel32, process/memory/display APIs. Preserve HWND/PID identity, COM lifetime and buffer layouts. High risk. |
| RTSS FPS / OSD / limiter | fps-rtss.js, rtss-osd.js, rtss-profile.js, rtss-startup.js | Rust can use the same RTSS shared-memory/profile interfaces. Retain bounds/version checks, owner slots, synchronization, atomics and profile restoration. RTSS remains an optional external program. High risk. |
| CPU MSR | msr-reader.js; IntelMSR.bin, AMDFamily17.bin, PawnIO_setup.exe | Native DeviceIoControl/module path reusable. Port handle ownership, protocol and unit decoding; preserve optional install/elevation boundary. High risk. |
| Hardware sensors | telemetry/lhm-provider.js; telemetry/lhm-runtime/ArcPower.LhmBridge.exe and its .NET DLLs | Retain the native/.NET helper and port bounded process/protocol/poll lifecycle. This removes Electron dependency but retains the .NET helper dependency. Medium risk. |
| D3D12 upload heap probe | windows-d3d12-uploadheap.js; native/ArcPower.D3D12UploadHeapQuery.exe | Retain executable, port process launch, timeout, structured result and hardware identity validation. Medium risk. |
| Screen sharpening / ASR | sharpening-screen.js; sharpening-runtime/ArcPower.ScreenSharpen.exe, fsr1 assets | Retain native capture/scale/present executable and shader assets. Port orchestration, stdio protocol, target selection, configuration/cancel/status and lifecycle. Runtime game evidence is still required. High risk. |
| Managed game sharpening | managed-game-launcher.js, managed-sharpening-control.js, managed-game-sharpening.js, managed-sharpening-runtime.js; ArcPower.GameSharpening.exe, ArcPower.ManagedSharpeningControl.exe, ArcPower.ReShade64.dll, shaders/ArcPowerSharpen.fx | Reusable native assets are present. Preserve only source-verified current product routes; presence on disk is not proof that every asset is active. Port whichever launch/control routes remain reachable without losing existing behavior. High risk. |
| Capture / replay | recording-engine.js; recording-runtime/bin/64bit/ascent-obs.exe, ascentobs-ffmpeg-mux.exe and full OBS plugins/data/hooks | Retain complete runtime tree, not just the main exe. Port command/event protocol, readiness, identifiers, encoder targeting, audio/record/replay states and shutdown. High risk. |
| Clip editing / validation | recording-editor.js, recording-thumbnails.js, recording-clip.js; recording-runtime/bin/64bit/ffmpeg.exe and ffprobe.exe plus DLLs | Retain binaries and port argument construction, output validation, progress, cancellation, temporary files and replay finalization. Medium/high risk. |
| Stability workload | gpu-workload.js, stability-lab.js, whea-check.js | D3D11 workload currently implemented through Koffi; requires a Rust implementation, including GPU matching and cleanup. WHEA query can use Windows APIs or a controlled system helper. High risk. |
| OBS connection / credentials | obs-stream.js; main.js safeStorage integration | Rust WebSocket and crypto implementation, secure credential store and compatibility/migration for saved passwords. No bundled OBS executable replaces this service. Medium/high risk. |
| Installer and updater | installer.js, auto-update*.js, intel-driver-*.js, startup-update*.js | Rust OS/network/filesystem/process implementations and native packaging. Preserve installed/portable distinction, integrity and rollback/handoff semantics. High risk. |

System-provided helpers such as PowerShell, reg.exe and task scheduling can remain OS dependencies where the current contract requires them; replacing them with native Windows APIs is preferable when practical, but is a separate decision from removing Electron. Record the final choice per feature.

Four JavaScript worker families cannot be mistaken for reusable native helpers: elevated apply-worker.js, Sysman helper-entry.js, sharpening-helper-entry.js, and rtss-profile-helper-entry.js. Their proxies launch the current executable / Electron run-as-Node paths. Port their protocols and failure isolation or provide purpose-built native worker modes. Simply retaining their JavaScript files leaves the old runtime requirement.

There are 153 JavaScript files under src/main, with 27 direct Koffi imports and 13 direct Electron imports in the static tree. These counts include legacy/diagnostic modules; they are scope indicators, not evidence that every file is reachable. PresentMon/ETW sources and PresentMon64.exe are present but excluded from the existing package's active product path; use main.js composition and packaging filters before treating them as required current runtime dependencies.

## Preserved policy and data prerequisites

- Define Rust request/response/event types for every command above, retaining exact names, argument validation, errors, null/unavailable semantics, tagged wire values where used and per-window authorization.
- Preserve per-device PCI/BDF/LUID identity, selection generation and durable key checks across async requests. Revalidate before writes and read back after writes; do not silently retarget a replacement device.
- Carry over concurrency and crash behavior: per-device apply serialization, timeout/cancellation markers, indeterminate-write quarantine, boot-session handling, refusal ceilings, rollback, helper recovery limits, shutdown drains and resource release.
- Preserve profile/settings/schema migrations, game records, recording clips/markers/settings, layouts, stability reports, display desired-versus-current state, startup/boot flags and encrypted credentials. Build migration fixtures from representative existing data without editing the user's live data.
- Preserve all non-IPC entry points: startup and boot apply, tray apply/actions, global shortcuts, foreground/game detection, worker CLI modes, timer-driven Arc Sleep/fan resume/recording, media protocol range requests, installer/uninstaller and updater handoffs.
- Resolve capabilities before enabling writes. Current unsupported hardware/features must retain honest degradation. A native rewrite must not promote a desired value, mock result or probe-only API to a verified live setting.

## Evidence required for native parity and Electron removal

No item in this section is claimed complete by this document.

1. Contract coverage: validate that every application command (155), all five installer commands and every push event has an explicit native implementation/test mapping or a documented unreachable legacy classification supported by source. Verify all six role permission maps, readiness phases, media requests and lifecycle operations. No generic 'unsupported' fallback may satisfy an existing supported feature.
2. Dependency coverage: enumerate the complete reachable runtime graph from native entry points, background modes and installation/update modes. Remove compatibility broker startup, Electron imports/run-as-Node workers and runtime dependency on app.asar. Frontend build-time Node tooling may remain if it is absent from the installed runtime and clearly recorded.
3. Payload inspection: recursively inventory the portable and installed payloads, nested archives and installer resources. Check file identities/metadata and dependencies, not just filenames, for renamed Electron/Chromium/Node runtimes, Electron libraries/resources and compatibility-backend remnants. Distinguish system WebView2's required browser subprocesses from bundled Electron. Keep licenses/notices for retained native/.NET/OBS/FFmpeg/ReShade assets.
4. Process evidence: capture executable path, parent/child tree and command line at startup, idle, each worker-backed feature, shutdown, restart, boot apply, installer/uninstaller and updater handoff. Verify no electron.exe, renamed Electron backend, Electron run-as-Node worker or hidden compatibility service runs. Verify failed/cancelled operations leave no orphan worker. Names alone cannot prove identity.
5. Functional evidence: run focused contract/schema/ABI tests, then matched UI workflows against the existing product. Include device selection, all supported OC/fan/VF/reset/waiver controls, profiles and boot apply, graphics/display, telemetry and RTSS/DXGI fallback, overlays/hotkeys/tray, games/Arc Sleep, sharpening/ASR with countdown and active Stop, recording/replay/editor/media/audio, OBS streaming/duck restore, stability cancellation, driver/app downloads and install/update/uninstall. Record exact hardware/driver/build. Explicitly identify any hardware or external-service coverage gaps.
6. Real hardware evidence: use read-only checks first. Hardware writes require the root/user's authorized validation scope and recoverable baselines. Validate read-back, target isolation, capability degradation, failed initialization and cancellation/crash paths. Unit tests or a mock do not establish native GPU behavior or game upscaling parity.
7. RAM comparison: compare the same reviewed builds, hardware, settings and feature workloads. Include at least startup peak, settled idle, telemetry/overlay, recording/replay, sharpening/ASR and post-stop idle. Capture the entire app-owned process tree (host, attributable WebView2 children and retained helpers), with per-process and summed private bytes/private working set plus total working set; document shared-page double-counting and the metric definition. Repeat comparable runs and report range/median and measurement timestamps. Do not claim savings from a host-only process or from an Electron-backed Tauri frontend. Preserve frame pacing/capture quality and workload equivalence while measuring.
8. Packaging acceptance: build the native portable and installer artifacts from the exact reviewed commit, verify administrator manifests and runtime assets, perform clean install/upgrade/uninstall and launch smoke checks, and retain hashes and logs. Packaging success alone is not feature or memory acceptance.
