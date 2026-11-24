# Changelog

## 1.3.4 — 2026-11-24

### Fixed

- **Installer upgrades no longer require removing the old version.** A stale,
  differently-named, or mismatched uninstall registration is repaired instead
  of blocking setup. Legacy uninstall keys are removed after the new
  registration lands. The uninstaller no longer refuses to run when its
  registration values are malformed.
- **Installer location.** New installs default to the all-users
  `%ProgramFiles%\Arc Power` folder. An existing per-user AppData install is
  offered a one-time move to Program Files; profiles and recordings are kept.
- **Recording folder Browse no longer crashes.** The picker now uses the
  classic `SHBrowseForFolder` browser instead of the modern shell folder
  dialog, which was crashing inside `Show` on this system. It runs on the
  thread that owns the main window, keeps the app's working folder unchanged,
  and writes a diagnostic trail to `%APPDATA%\ArcPower\dialog.log`.
- **A-series undervolt no longer invents a core-clock offset (issue #37).**
  The negative-voltage Sysman path still returns the requested (or pre-apply)
  frequency offset, and a session guard now keeps that value on every later
  `get-current-settings` read instead of exposing the driver's derived
  `+172 MHz`. A zero/positive voltage apply or reset-to-defaults clears the
  guard.
- **Fan applies handle duplicate top temperatures, the 20 C floor and mode lag.** A curve with
  two points at 100 C is now pulled back to 99/100 C instead of being sent as
  101 C, which the driver silently rejected and left in Auto. The editor and
  normalizer now use the driver's 20-100 C table range, so a 0 C first point is
  moved to 20 C. After a successful table write that still reads back `auto`,
  the app also does one controlled default/table re-entry before failing.
- **A-series fan capability restored.** The native fan probe now blocks on the
  shared GPU apply mutex instead of skipping when it is briefly held. An
  apply-triggered capabilities read could otherwise skip the reversible probe
  and leave an A770 fan reported as read-only (`canControl=false`) for the
  session.
- **Consistent 252–315 W power routing.** The planner and executor now agree on
  one threshold: 252–315 W always uses the bundled 2023 Intel runtime, and only
  above 315 W uses the Level Zero Sysman sustained/burst pair. A 252–315 W
  boot/tray apply no longer skips the 2023-runtime gate and then fails at
  write time.
- **Overlay monitor selection.** Overlay Settings now has an Overlay Monitors
  card for the Arc Power HUD and the Advanced Overlay. The choice is saved in
  `%APPDATA%\ArcPower\overlay-monitors.json` and applied immediately. RTSS
  continues to follow the game window.
- **Uninstaller running-app check.** The setup and removal now enumerate
  processes natively instead of running PowerShell/WMI. If Arc Power is still
  open, the page shows "Close Arc Power before installing or removing it, then
  retry." instead of a CLIXML error.
- **Reset to defaults now resets the whole device.** It calls the driver's
  `ctlOverclockResetToDefault` under the shared apply locks, clears GPU locks
  and VF curves, and verifies every supported control before reporting
  success. Older drivers fall back to the per-control patch and still refuse
  an unverified result.
- **Tray/boot apply read-back reaches the renderer.** `device:state-updated`
  is now wire-encoded like every other native event.
- **Stock/Advanced mode changes propagate between windows.** Native
  `oc-mode-set` broadcasts `oc-mode:updated` with fresh caps/state and a
  monotonic revision to the main window and Advanced Overlay.
- **Overlay settings contract.** The HUD push now sends
  `overlayChipNames`/`overlayPollMs`; `overlay:get-state` returns the complete
  state; `overlay-resize` honors the renderer's measured GPU count; enabling
  the software HUD reveals an existing window; disabling or switching to RTSS
  destroys the resident WebView process.
- **Overlay styling.** The Advanced Overlay active tab now wins against the
  shared `.oc-mode-btn.active` rule instead of being overridden.
- **Sysinfo startup safety.** The first CIM snapshot has a hard 10 s process
  deadline, runs off the async workers, and retries after a transient failure
  instead of latching null for the session.
- **Native-only fan control.** When Electron's success-only fan-probe cache is
  missing, the packaged native host runs the same reversible probe and
  restores default mode before accepting fan control. The probe holds the
  shared GPU apply mutex (bounded, skipped when busy) so it cannot interleave
  with another writer.
- **Extended temperature setpoints are remembered for the session**, so a page
  refresh does not show the legacy 90 °C sentinel after an accepted extended
  apply.
- **Window maximize state** is emitted natively in native-only runs.
- **WebView setup and uninstaller.** The installer now opens the Arc Power
  setup window with the Electron branding: version, install location picker,
  desktop shortcut, launch-after-install, optional RTSS installation through
  WinGet, progress and finish. The uninstaller uses the same window and keeps
  the existing cleanup helper. If WebView2 setup cannot start, the classic
  prompt flow remains as the fallback.
- **GPU usage matches Task Manager's busiest engine.** The overlay now takes
  the higher of the D3DKMT node reading and the Windows GPU Engine (PDH)
  reading, so a Compute-heavy workload at 100% is no longer hidden behind a
  30% 3D engine. The source is recorded in `gpuUtilSource`.
- **Recording start/stop events are logged.** `%APPDATA%\ArcPower\recording.log`
  now records the requested encoder, resolved runtime encoder, target,
  start result, and every started/stopped/error event. This is the missing
  evidence for the B390 report where recording stops after about one second.
- **Delayed ReBAR refresh** joins the verdict into the existing inventory
  instead of replacing the device list and potentially retargeting the
  focused GPU.
- **Installer move safety.** If the old per-user folder contains files Setup
  did not install, it is kept with a notice instead of being deleted.
- **Packaging guard.** The native packager refuses a renderer bundle that is
  older than `src/renderer`, and both NSIS wrappers now carry 1.3.4 version
  metadata so a stale portable is identifiable in Explorer.
- **Declined native applies** report a product refusal instead of leaking the
  compatibility transport error; `boot-apply-outcome` only returns null in a
  headless run.
- **Test suites.** Fixed the bin exit-attribution extractor, the compatibility
  packaging `ReferenceError`, the native-only staging coverage, the
  profile-apply/version fixtures, and several stale Electron/UI source tests.

### Added

- **Sidebar tab visibility.** Settings → Navigation now lets you hide Graphics,
  Arc Sleep, Monitoring, Recording, Profiles and Tweaks from the sidebar.
  Dashboard, Tuning and Settings always stay visible. The preference is stored
  locally, like the sidebar width.

### Changed

- Version 1.3.4 across the app, installer, README and website.

### Verification

- `tsc --noEmit` clean.
- `cargo test --lib`: 1063 passed, 0 failed, 25 ignored.
- `cargo test --bins`: 96 passed, 0 failed, 1 ignored.- `cargo check --bins` clean.
- Focused node suites for overlay, ReBAR, settings, profile apply, temperature
  lease, version, theme, documentation and packaging: green.
- Native-only payload verified: no Electron binary, no compatibility backend,
  all required runtimes present, administrator manifests on both wrappers.

Live gates still requiring a desktop run: upgrading from 1.3.2/1.3.3, the
recording-folder picker, the reversible fan probe and repeated fan applies, the
A770 undervolt/refresh, B580 ReBAR detection, overlay/toast/splash behavior,
reset-to-defaults, and the display/Arc Sync writes.

## 1.3.3 — 2026-11-24

- Fixed the A770 negative-voltage apply reporting a derived positive core
  clock offset (for example `+172 MHz`) and capturing it into profiles.
- Fixed manual fan applies failing after several changes in one session.

## 1.3.2 — 2026-11-23

- Native-only startup, settings, profile, recording, overlay and fan hotfixes.
