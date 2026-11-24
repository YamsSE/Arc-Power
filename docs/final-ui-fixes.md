# Final UI/driver fixes (pending distributable)

| Reported issue | Fix | Code |
|---|---|---|
| Overlay always centred regardless of selected corner | Native overlay geometry now derives position and scale from `overlayPosition` / `overlayScale` | `main.rs::native_overlay_geometry`, `native_overlay_apply_geometry` |
| Overlay colour/background/size/°C-°F/stats changes did nothing | Settings pushes now reach the live overlay WebView immediately after a native save; geometry is reapplied too | `main.rs::publish_native_overlay_settings`, `native_overlay_apply_geometry`, `bridge_invoke` overlay-change reaction |
| ReBAR still gray with ReBAR on | Replaced WMI-only detection with the driver's own `ctlPciGetProperties` verdict (64-byte layout, sentinel checks), WMI kept as fallback | `igcl_raw.rs`, `igcl_read_only.rs::rebar_enabled`, `graphics.rs::rebar_enabled`, `native_sysinfo.rs` |
| Post-process had no usable NONE | Added a real NONE button to the Scale card that writes `None` through the native hotkey channel | `components/sharpening.ts::clearScaleHotkey` |
| Advanced Overlay did not match the app UI | Shared stylesheet plus section kicker, square tabs with synced active state, and Tuning Controls hero matching the main Tuning tab | `advanced-overlay.html`, `advanced-overlay.css`, `advanced-overlay.ts` |
| Overlay settings still did nothing after the first push | The renderer reads `overlayBgEnabled`/`overlayBgColor`/`overlayBgOpacity`; the native push was sending unprefixed keys | `main.rs::publish_native_overlay_settings` |
| Selected corner still not used | Geometry now uses the monitor hosting the main window (not just the system primary) and is reapplied on settings saves; diagnostic logging added | `main.rs::native_overlay_geometry`, `native_overlay_apply_geometry` |

## Verification

- Rust lib 1059 passed / 0 failed / 25 ignored; bins 95 passed / 0 failed / 1 ignored.
- `check --bins` exit 0; `tsc --noEmit` exit 0.

## Live gates

The driver ReBAR verdict and the overlay WebView behaviour still need one real-session check: open the Display/Monitoring view, confirm ReBAR is green, change overlay position/colour/size/temperature unit/stats and confirm the HUD follows without reopening; press the overlay hotkey and confirm the chosen corner.
