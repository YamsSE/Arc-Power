# Memory cleanup pass

No live heap snapshot was possible from this environment: the packaged host
requests elevation, so launching it from the harness blocks on UAC. The pass
therefore targeted allocations that are provably redundant in code, without
changing user-visible behaviour.

## Changes

1. **No redundant settings snapshots in native-only runs.**
   `push_settings_cache` cloned the whole settings document and forwarded it on
   every native save, even though the compatibility `NativeProfileStore` no
   longer exists in packaged builds. It now returns immediately when the broker
   pipe is absent. Dev/mock runs keep the push for parity.

2. **Compacted the cached CIM snapshot.**
   `backend/native_sysinfo.rs` cached the full WMI response including every
   `Win32_DeviceMemoryAddress` row, although only the derived "large BAR"
   verdict and the allocation owner strings are read afterwards. The cache now
   stores just CPU, physical memory, baseboard, `largeBar`, and the allocation
   text; the large range rows are discarded after the verdict is computed.

3. **Bounded the driver release cache.**
   `pages/driver-library.ts` cached every release detail fetched in a session.
   It is now capped at the 64 most recently viewed versions.

## What was checked and left alone

- Renderer telemetry series are already capped at 60 points per series and
  time-trimmed (`pure/telemetry-visuals.ts`), so they do not grow without bound.
- Module-level DOM node maps in `graphics.ts` and `tuning.ts` are cleared on
  re-render.
- The recording toast WebView is already destroyed after its bounded display
  duration; the overlay window is created lazily.
- No code splitting change was made: the Tauri frontend is built as a single
  IIFE bundle, and changing that would require changing the loading contract
  for all auxiliary windows. That is a separate, higher-risk pass.

## Verification

- Rust lib 1021 passed / 0 failed / 25 ignored; bins 74 passed / 0 failed / 1 ignored.
- `check --bins` exit 0; `tsc --noEmit` exit 0.

## Needed to confirm impact

A live before/after measurement with Task Manager or Process Explorer is still
required: launch the packaged app, leave the Dashboard open for 15 minutes,
and compare the working set / private bytes of `Arc Power.exe` and its WebView2
processes against the previous build. The reductions above are small but
monotonic; they do not change visible behaviour.
