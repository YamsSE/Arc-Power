# Changelog

## 1.3.6 — 2026-11-26

### Fixed

- **Monitoring could stay blank on a slow sensor start.** The
  LibreHardwareMonitor bridge's first sample enumerates every sensor the host
  allows (MSR clocks/voltage/power, SuperIO fans, SPD, the GPU) and can take
  longer than the steady-state poll timeout. The app killed and restarted the
  bridge every 6 seconds, so no CPU or GPU telemetry ever arrived while the
  D3DKMT utilization, memory and CPU-frequency fallbacks kept showing partial
  data. The first request after a bridge start now gets a 30-second window.
- **Start-at-boot, profile delete and Full Reset work on non-English Windows.**
  `reg` and `schtasks` localize their "value/task not found" messages, but the
  startup code matched English words only. On German Windows a missing
  `ArcPower` Run value or `ArcPowerStartup` task was reported as a failure
  ("task query failed: Das System kann die angegebene Datei nicht finden"),
  which broke the Start-at-boot toggle, profile deletion and the Full Reset
  snapshot. Absence is now detected by the tools' exit code. Their output is
  also decoded from the console OEM code page, so Russian and CJK installs no
  longer show mojibake in these messages.
- **Starting RTSS with Windows can be enabled again.** The RTSS startup
  registration check had the same English-only matching, so a missing
  `ArcPowerRTSS` value made the toggle fail on localized Windows when enabling
  or disabling it.
- **Game scan survives and explains a bad entry.** The scan aborted with "Game
  scan failed safely" whenever one entry panicked. Stripping a trailing `.exe`
  sliced at `len - 4`, which panics when the name ends in a multi-byte
  character (e.g. "Grüße.exe"), and a single malformed uninstall entry,
  shortcut or artwork file could blank the whole catalog. Each phase is now
  isolated and the fallback reports the actual panic.

## 1.3.5 — 2026-11-26

### Fixed
- **Updates and reinstalls no longer hit "access denied" on a locked install
  folder.** When the recording runtime, LHM bridge, sharpening helper or
  compatibility backend is still holding the install directory open, setup and
  the update worker now terminate those Arc Power helpers and retry the
  directory move instead of failing on `os error 5`.
- **Profiles apply on boot after moving the install.** Setup re-points the
  Windows startup logon task (and legacy Run value) at the new executable when
  the install location changes, so the app still launches at logon and runs the
  `ocOnBoot` profile apply instead of silently pointing at the old path.
- **RTSS overlay chip names.** The native OSD now respects the Chip Names
  toggle: the GPU row shows the model ("B580") only when the toggle is on and
  "GPU" when off, the CPU row shows the cut-down model ("i7 5960X", "R5 3600"),
  the VRAM row is always plain "VRAM", and factory memory tokens
  ("12GB GDDR6") are dropped from the label. Multi-GPU rows are numbered when
  chip names are off.
- **Hotkey grammar.** Every hotkey field now accepts a single function key
  (F1-F24) on its own. Letters and numbers still need Ctrl, Alt, or Shift, and
  two-modifier chords (for example Ctrl+Alt+F1) are always accepted.
- **Single instance.** A second Arc Power launch now exits instead of starting
  a duplicate tray, overlays, hotkeys and recording engine.
- **Arc Power Overlay starts when selected.** Switching the renderer to the Arc
  Power Overlay (or enabling the overlay, or saving a layout change) starts the
  software HUD again. A recent change had left it to the hotkey only, so the HUD
  appeared not to start.
- **Arc Image Sharpening / ASR frame pacing.** The capture-overlay provider is
  gated off in production: its second composition presentation changed the
  game's VRR/frame-pacing path and produced erratic frame times. Settings stay
  stored, but sharpening reports unavailable and the helper never launches
  until a non-intrusive path exists.

### Added

- **Highest power plan tweak.** A Tweaks card switches the Windows power plan
  between High performance and Balanced with `powercfg /setactive`.
- **Windows Update driver exclusion.** A Tweaks card writes
  `HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\ExcludeWUDriversInQualityUpdate=1`
  so Windows Update stops pushing an older driver over the clean install.
- **Intel oneVPL encoder option.** The bundled `obs-qsv-onevpl-boost` plugin
  now registers its frame encoders under ids the Ascent recorder host accepts
  (`obs_qsv11_vpl_av1/hevc/h264`), so "AV1 (oneVPL)", "HEVC (oneVPL)" and
  "H264 (oneVPL)" appear as Intel choices and are preferred for automatic
  selection. The plugin's texture encoders cannot create a oneVPL D3D11 session
  under this recorder host, so these run through the plugin's frame path; the
  built-in `obs_qsv11` texture encoders remain as the fallback (and are picked
  automatically if a oneVPL start fails). Saved `obs_qsv_vpl_*` selections
  resolve to the built-in encoders.

### Changed

- **Tweaks.** Removed the read-only Fullscreen Optimizations card.
- Version 1.3.5 across the app, installer, README and website.

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
- **Tray memory.** The main WebView2 is suspended with the official
  `TrySuspend` when the window is hidden to the tray or minimized, and resumed
  when shown. The controller is explicitly set `IsVisible(false)` first because
  WebView2 refuses to suspend a visible webview; the result is logged to
  `%APPDATA%\ArcPower\webview.log`. The Arc Power HUD, Advanced Overlay,
  recording toast and status pill are separate WebViews; RTSS is native shared
  memory, so none of them depend on the main UI WebView.
- **Inactive pages.** Leaving a tab or hiding the window clears the page DOM,
  runs the page's `leave` hooks (timers, canvases, media, subscriptions), and
  rebuilds the page from persisted state when it returns.
- **Clip hover previews.** Hover videos are metadata-only until hovered and are
  fully removed, with `src` cleared and `load()` called, on pointer leave,
  list redraw, tab change, player open and page leave.
- **CI smoke.** The GitHub workflow now runs the headless mock smoke instead of
  a local-only UI harness that is not committed.
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
