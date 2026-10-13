# Arc Power branding

The approved blue gradient mark is preserved in `Arc-Power-Mark.svg`. The
complete product lockup is `Arc-Power-Main-Logo.svg`, with the original lettering
stored as paths so that rendering does not depend on an installed font.
`Arc-Power-Main-Logo.png` is transparent. `Arc-Power-Main-Logo-Navy.png` is the
README version, keeping the white lettering visible in both light and dark themes.

The four mark paths share these colors:

| Part | Gradient |
|---|---|
| Left | `#8FD8FF` → `#4CC2FF` at 55% → `#1F9CE8` |
| Right | `#69CFFF` → `#3978E8` |
| Bottom | `#2BC4D7` → `#4CC2FF` |
| Center | `#8FD8FF` |

Opaque artwork uses `#10121E`; lettering uses `#FFFFFF`. Desktop icons and UI
marks have transparent backgrounds. Preserve the path geometry, gradient
directions, original lettering, and smooth antialiased edges when exporting.
Render each required raster size directly from the vector geometry, without
upscaling an existing PNG or adding a shadow, texture, or sharpening.

The ICO files in `src/assets/app-icon.ico`, `build/icon.ico`, and
`build/installerIcon.ico` contain exactly five PNG frames: 16, 32, 64, 128, and
256 pixels. Their matching PNG sources are used by the application, installer,
and website. The embedded `TRAY_ICON_DATA_URL` in `src/main/tray.js` must match
`src/assets/tray-icon.png` whenever that 32 pixel asset changes.

The website keeps its 1200 × 630 social preview in `website/assets/og.png` and
its 1920 × 360 banner in `website/assets/discord-banner.png`. The legacy
installer header and sidebar retain their 150 × 57 and 164 × 314 dimensions.
