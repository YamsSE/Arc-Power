# Electron removal plan (1.3 → Electron-free)

Status: **complete**. The Electron-free distributable is built at
`dist-tauri/arcsync-1.3.0-20261120-electron-free/` and contains no Electron
binary and no compatibility-backend payload. Dev/mock runs still use the
compatibility service for differential fixtures; packaged runs do not.

## What was done

### Phase 1 — Native boot apply
`host_boot_apply` shares the tray's `host_profile_apply_all` coordinator:
every active GPU profile is planned before any setter, one unproven entry keeps
the whole action broker-owned, and `ocOnBoot` gates the run. The broker is
launched with `ARC_POWER_NATIVE_BOOT_APPLY=1` in dev/mock runs; packaged runs
never launch it.

### Phase 2 — Delegated settings keys
All 35 `profiles-settings-save` keys are native. The remaining 17 overlay keys
were ported with their Electron validators (position, renderer, hex colors,
stats, device keys, hotkey letter, booleans, scale/opacity/poll clamps, theme,
collision order), plus `memorySavingMode` with a native recording-hub reaction.
The parity fixture has 230 cases. Only unknown keys and values the tagged codec
cannot reduce to plain JSON still delegate.

### Phase 3 — Native recording toast
`native_recording_toast` creates a host-owned passive WebView lazily, emits
`recording:notification` through the `arc-power:broker-event` envelope, derives
start/stop and action-result toasts from native recording events, and destroys
the window after a bounded delay. Dev/mock runs keep the Electron window via
`ARC_POWER_NATIVE_RECORDING_TOAST=0`.

### Phase 4 — Remaining channels and process removal
- `health`: native wire-encoded report.
- `sysinfo:get`: new `backend/native_sysinfo.rs`, built from Win32 registry and
  memory APIs plus the native GPU inventory; unknown fields stay null.
- `fps-poll`: native RTSS foreground FPS/frametime/API rows.
- `reset-to-defaults`: builds the patch from each device's capability
  `default` values plus auto fan and the driver's stock VF curve, then applies
  it through the native FIFO.
- Private temperature lease: `native_private_invoke` in `main.rs` replaces
  Electron's `__native-temperature-apply-lease:{begin,finish,cancel}` service.
  It holds the native apply FIFO, publishes refusals to the native cache, and
  produces the begin/finish envelopes the fail-closed lease assertions verify.
- Media: already native outside mock mode.
- `Broker::start` runs headless in packaged builds: no compatibility process,
  no pipe, no readiness wait. Writer/child are optional, and `request()` fails
  closed if anything unexpectedly tries to use a missing service.
- `build-tauri-dist.mjs --native-only` omits `compatibility-backend`, copies
  the bundled PawnIO installer to `resources/`, and records the native-only
  provenance.

## Verification
- Rust lib 1021/0, bins 74/0, `check --bins` exit 0.
- Node parity/boot tests 12/12.
- Packaged payload check: no `electron.exe`, no `compatibility-backend`,
  native hash matches, both wrappers `requireAdministrator`.

## Residual gates
- No live GPU/display apply was performed by automation. Boot apply, tray
  apply, temperature lease, reset-to-defaults and the toast window need an
  approved desktop pass on real hardware.
- Dev/mock runs still spawn Electron intentionally; a mock-only distributable
  would need the mock media bridge ported too.
