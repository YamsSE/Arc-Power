# Migration review findings (Tauri / Electron removal)

Review pass: hy4, performed after the Electron-free package was first produced.
All findings below were found in the migration code itself and fixed in the
tree; the packaged build at `dist-tauri/arcsync-1.3.0-20261120-reviewed/`
contains the fixes.

| # | Finding | Root cause | Fix |
|---|---|---|---|
| 1 | Startup failed with "Compatibility service is unavailable in native-only builds" | Host event loop forwarded locally generated events to the (absent) broker pipe with `Broker::send` | Headless runs now skip that forward; local consumers (tray, pill, telemetry, toasts) still receive the events |
| 2 | `boot-apply-outcome` had no native handler | The renderer calls it at boot; it was one of the 153 contract channels with no native arm | Native reply returns `null`, which the renderer accepts as "no Electron outcome record" |
| 3 | Splash stayed on "Loading Arc Power..." | Electron sent `startup-splash-dismiss`; in native-only runs nobody did | `renderer_ready` dismisses the splash once the main renderer is ready; choosing "skip update" also dismisses it |
| 4 | Temperature applies could fail their finish acknowledgement | Native lease emitted `attemptedSettings: {"tempLimitC": null}` when no setter ran; the existing ack expects the key to be absent | Finish snapshot omits the key when there is no attempted value |
| 5 | Arc Sync "Applied" chip never appeared; a second Apply restored Intel's 90–180 default | Applied baseline came from `displayDriverValue`, which is `null` unless the profile is `custom`; draft was cleared to `null`, so the next Apply sent the restore request | Applied baseline and draft are both set from the per-control evidence of the actual write |
| 6 | ReBAR showed gray even with ReBAR active | WMI address strings were parsed as decimal although they are frequently hex; additionally any large BAR was accepted | Parse `0x` addresses as hex, and require the allocation to mention that adapter's PNP/VEN+DEV before accepting a large BAR |
| 7 | Recording toasts did not appear even when enabled | The notification was emitted 180 ms after window creation, before the WebView was listening; no retry existed | Pending payload is flushed from `renderer_ready` for the toast role, with the delayed emit retained as a second path |
| 8 | Native overlay hotkey did nothing / Ctrl+O conflicted with browser open-file | Only the RTSS OSD was toggled; no native overlay WebView existed, and the default `O` chord became `Control+O` | Added a host-owned overlay window toggle with settings push; default moved to `Alt+F8` |
| 9 | Ctrl+P opened the printer menu | Advanced Overlay default `P` became `Control+P` | Default moved to `Alt+F9`; parity fixtures and generators updated |
| 10 | Arc Sleep showed "Unavailable" when IGCL was the active limiter | Snapshot only reported `activeLimiter` from the limiter route, which can be `None` while IGCL was detected in the session | Snapshot falls back to `igcl` when RTSS is unavailable and an IGCL read was previously successful |
| 11 | Advanced Overlay kept the old panel styling | It loaded only its standalone stylesheet, a copy of older component rules | The shared `styles.css` is loaded first so the panel uses the same card/chip/tuning surfaces as Dashboard and Tuning |
| 12 | CPU/RAM/mainboard fields and ReBAR were missing after the native sysinfo port | Native sysinfo returned nulls for WMI-only fields and had no ReBAR source | One cached, read-only CIM collection now supplies CPU cores/threads/clock, RAM vendor/speed/type, mainboard, and BAR evidence |

## Residual observations (not fixed here)

- The native sysinfo CIM query adds roughly one 1–2 s PowerShell call on first use; it is cached per process afterwards.
- `arcSyncDriverDefault` is captured when the driver is in a non-custom profile. If an app starts with a custom window already applied, "Restore default" falls back to the current window rather than Intel's original one.
- Native-only mock runs would need the mock media bridge ported; dev/mock runs intentionally still use Electron for differential fixtures.

## Verification

- Rust lib 1059 passed / 0 failed / 25 ignored; bins 95 passed / 0 failed / 1 ignored.
- `check --bins` exit 0; `tsc --noEmit` exit 0.
- Packaged payload: no Electron binary, no compatibility backend, native hash matches, wrappers `requireAdministrator`.

Live hardware gates still outstanding: profile/boot/tray applies, temperature lease,
reset-to-defaults, recording toast visibility, overlay hotkey, and the
Graphics/Display write paths were not exercised by automation.
