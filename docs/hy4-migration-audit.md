# hy4 migration audit (1.3.3 tree)

> **Resolved in 1.3.4.** Every high/medium finding below was fixed in the
> 1.3.4 tree, including the reset-to-defaults driver reset, the
> `device:state-updated` wire encoding, the native `oc-mode:updated`
> broadcast, the bounded CIM query, the overlay contract/lifecycle fixes, the
> native-only fan probe, and the red bin/packaging tests. See `CHANGELOG.md`
> for the shipped list and `dist-tauri/arcpower-1.3.4-20261124-native/` for
> the verified payload. The live gates named at the end of this file still
> require a desktop run.

Scope: the Tauri/Electron-removal migration and the changes attributed to the
`hy4` review pass, plus the follow-up overlay/ReBAR/settings work.

Method: four independent read-only reviews (overlay/ReBAR, apply/settings,
bridge/UI, tests) on `opencode-go/deepseek-v4.1-flash#high`, followed by direct
verification of the high findings and the red tests on the local tree. No live
GPU/display writes were performed.

Overall: the core apply-safety path is intact and the 35-key native settings
port is sound. The migration did, however, leave several real functional gaps
and two red test suites. **The 1.3.3 package should not be treated as final
until at least the high findings below are fixed.**

## High findings

### 1. Reset-to-defaults does not clear the GPU lock and never verifies the result
`src-tauri/src/main.rs:3030-3087`

`reset_settings_from_capabilities` builds the reset only from
`caps.ranges[*].default`, `fanMode:auto`, and `state.vfCurveDefault`. `gpuLock`
is not in `caps.ranges`, so it is never included, and
`ctlOverclockResetToDefault` is declared but never invoked. The reply returns
the apply state without a read-back loop.

Impact: a card with an applied voltage/frequency lock can stay locked, a custom
VF curve can survive when `vfCurveDefault` is null, and a silent no-op can look
successful. Electron called `ctlOverclockResetToDefault` and verified every
supported control, including `gpuLock == (0,0)`.

Fix: route the reset through the driver reset or add an explicit lock/VF reset
plus Electron's bounded capability/state verification before replying.

### 2. Tray/boot apply read-back is dropped by the renderer bridge
`src-tauri/src/main.rs:3431-3436`

The native tray/boot executor emits `device:state-updated` with a raw `args`
array. The renderer adapter decodes `payload.args` through the tagged wire
codec (`src/renderer/platform/tauri-electron-adapter.ts:19`,
`src/shared/tauri-wire.js:5-8`), which throws on an untagged array.

Impact: after a native tray "Apply active profile" or native boot apply, the
main window's `onStateUpdated` never runs. The dashboard OC row, driver-sync
readout, and Tuning applied reference stay stale.

Fix: encode the args with `wire::encode_json(&json!([...]))`, like every other
native emitter, and add a decode test.

### 3. Native `oc-mode-set` does not broadcast `oc-mode:updated`
`src-tauri/src/backend/services.rs:535-569`

The native handler persists the mode but emits no event; `oc-mode:updated`
appears nowhere in `src-tauri`. Both consumers require it to rebuild caps/state
(`src/renderer/app.ts:332-356`, `src/renderer/advanced-overlay.ts:453-485`).
Electron broadcasts it with `{deviceId, deviceKey, ocMode, caps, state,
revision}` (`src/main/ipc.js:518-552`).

Impact: changing Stock/Advanced in one window leaves the other showing stale
ranges until a device switch or reload.

Fix: after a successful native `oc-mode-set`, read caps/state for the resolved
device and emit the same payload to `main` and every advanced-overlay window
with a monotonic revision.

### 4. `sysinfo:get` can block boot indefinitely
`src-tauri/src/backend/native_sysinfo.rs:51-93`, `src-tauri/src/main.rs:3720`

`wmi_snapshot()` uses `Command::output()` with no overall timeout; only two of
the five CIM queries carry `-OperationTimeoutSec 2`. The result is cached in
`OnceLock<Option<Value>>`, so a failure is permanent for the process.
`sysinfo:get` is called synchronously on the async command path, and the
renderer awaits it before `rendererReady` (`src/renderer/app.ts:760`).

Impact: a wedged CIM query reproduces the original "stuck on Loading Arc
Power" symptom and permanently degrades the WMI fields for that session.

Fix: run the PowerShell with a hard deadline/kill path, cache only success,
allow a later retry, and route the native sysinfo branch through
`spawn_blocking`.

### 5. Two test suites are red and the docs claim they are green
- `cargo test --bins` → 94 passed / 1 failed / 1 ignored.  
  `src-tauri/src/main.rs:4692` splits `main.rs` at the first `#[cfg(test)]`,
  which truncates at line 773 and misses most exit sites.
- `node --test scripts/build-tauri-dist.test.mjs` → ReferenceError:
  `backendExecutable is not defined`.  
  `scripts/build-tauri-dist.mjs:102-110` declares `backendExecutable`/`archive`
  inside `if (!nativeOnly)`, but the provenance object reads them at 185-186.

Impact: the "bins 74/0/1" and "all tests green" claims are stale; the
compatibility packaging path is broken, and the native-only branch has no
default test.

Fix: split at the final test module (or strip all `#[cfg(test)]` modules),
hoist the compatibility paths, and add a default native-only staging test.

## Medium findings

| Finding | Evidence | Impact |
|---|---|---|
| Fan control is read-only on a fresh native-only install when no Electron probe cache exists | `gpu_capabilities.rs:217-232`, `services.rs:711-724` | A770/Bifrost fan control never enables; `apply_fan` refuses with `canControl=false`. Electron ran the reversible probe and persisted the cache. Restoring it is a live fan write and needs explicit approval. |
| Overlay push sends `chipNames`/`pollMs` but the renderer reads `overlayChipNames`/`overlayPollMs` | `main.rs:3125-3126`, `overlay.ts:551,555` | Chip names never appear; a non-default FPS poll cadence is ignored. |
| `overlay:get-state` returns only `{exists, visible}` for the software HUD | `main.rs:3664-3665`, `overlay-settings.ts:286-301` | The Overlay page can say "Overlay disabled" while the master switch is on. |
| `overlay-resize` ignores the renderer's measured GPU count | `main.rs:3663`, `overlay.ts:1333` | Multi-GPU HUDs can be clipped because the host sizes for one GPU. |
| Enabling the software (capframex) overlay from Settings never shows the HUD | `main.rs:3135-3151` | Only the hotkey creates/shows the window; the Settings toggle appears to do nothing. |
| Delayed sysinfo refresh replaces the device list without re-resolving the focused id/caps/state | `app.ts:781-803` | A reassigned numeric id can target/display the wrong GPU. |
| `window:maximized-changed` is queued but dropped in native-only | `main.rs:4443-4451`, `1584-1591` | The custom titlebar max icon/tooltip stays stale. |
| Accepted extended temperature setpoint is not remembered in native-only | `services.rs:1474-1489` | A page refresh can show the 90 °C sentinel after an accepted extended limit. |
| Advanced Overlay active tab is overridden by the shared `.oc-mode-btn.active` rule | `styles.css:1809-1812`, `advanced-overlay.css:305-311` | The intended accent-soft tab is replaced by a solid accent fill; the panel still duplicates shared component rules. |
| Fan settle retries can consume most of the 10 s apply-FIFO budget | `fan_apply.rs:103-126` | A concurrent tray/boot apply can get "GPU apply is busy". |

## Low / informational findings

- Recording-toast pending slot is single-slot and can double-deliver
  (`main.rs:3234-3247`).
- A declined native apply in a native-only run surfaces the compatibility
  transport error (`main.rs:3705-3718`).
- `boot-apply-outcome` returns null even in broker-backed runs
  (`main.rs:3496-3500`).
- No main-ready watchdog reveals a hidden main window when splash is skipped
  (`main.rs:4378-4394`).
- Old hotkey defaults (bare `O`/`P` → Ctrl+O/Ctrl+P) are not migrated for
  upgraded installs; README and one node test still document the old chords.
- Arc Sleep `activeLimiter` can latch on stale IGCL identity
  (`arc_sleep_limiter.rs:298-303`).
- `overlayLabelColor`/`overlayValueColor` validation reports the
  `overlayColor` message (`settings_patch.rs:362-364`).
- `tauri-aux.ts` is dead code duplicated by the build script.
- The JS window-role id mirror accepts 6-digit ids while Rust requires
  >= 1,000,000.
- The generated bridge contract has no freshness check against
  `src/preload.cjs`.
- Splash subscribes to `update:download-progress`, which the splash role is
  not authorized to receive.

## What is correct

- 35-key native settings patch, validators, save queue, and Arc Sleep state
  re-injection.
- Apply identity, FIFO ordering, named mutex, read-back verification, and
  compensating rollback.
- Arc Sync per-system bounds and restore verification.
- Splash ready/timeout/watchdog handoff.
- Headless host-event forward guard.
- Advanced Overlay panel lifecycle and role fan-out.
- ReBAR driver decode (`ctlPciGetProperties` 64-byte layout, sentinels) and the
  dashboard identity join.
- Native-only packaging runtime assertions.

## Recommended fix order

**Phase 1 — no live hardware**
1. Encode `device:state-updated` args.
2. Emit `oc-mode:updated` after native `oc-mode-set`.
3. Bound the CIM PowerShell call and move `sysinfo:get` off the async worker.
4. Fix the overlay push keys, `overlay:get-state`, `overlay-resize`, and the
   software-overlay reveal.
5. Emit `window:maximized-changed` natively; re-resolve the focused device
   after the delayed sysinfo refresh.
6. Fix the `production_source` test, the `build-tauri-dist` scope bug, and add
   the native-only staging test.
7. Fix the Advanced Overlay tab specificity and the stale hotkey tests/README.

**Phase 2 — hardware / product decisions**
1. Reset-to-defaults: driver reset or explicit lock/VF reset plus verification.
2. Fan probe: restore the reversible probe + cache for native-only (explicit
   approval required before any live fan write).
3. Accepted extended temperature setpoint persistence.
4. Hotkey default migration decision for upgraded installs.

**Phase 3 — release**
Rebuild and re-verify the native-only installer/portable, rerun
`cargo test --lib`, `cargo test --bins`, the node suites, `tsc --noEmit`, and
the live gates (A770 undervolt, B580 ReBAR, fan applies, overlay, toasts,
splash, Arc Sync restore).

## Test coverage gaps

- No Rust tests for `rebar_from_wmi`, `parse_d3d12_output`, `d3d12_targets`,
  or `ctlPciGetProperties`.
- No producer test for the temperature finish `attemptedSettings` omission.
- No test for the headless host-event guard, recording-toast pending flush, HUD
  geometry, or the Arc Sync renderer baseline.
- The full suite is not covered by `cargo test --lib`; `cargo test --bins` and
  the node suites must be part of the release gate.
