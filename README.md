<p align="center">
  <img src="docs/branding/Arc-Power-Main-Logo-Navy.png?v=1.3.6" alt="Arc Power" width="540">
</p>

<p align="center">
  <a href="https://discord.gg/nXAjasHy6e"><img src="https://api.iconify.design/simple-icons/discord.svg?color=%235865F2" alt="Join the Arc Power Discord" title="Join the Arc Power Discord" width="22" height="22"></a>
</p>

# Arc Power Ver. 1.3.6

Arc Power is an open source Windows application for Intel Arc GPU tuning, monitoring, and control. Version 1.3.6 is a bug-fix release: monitoring recovers on machines where the sensor bridge's first read is slow, start-at-boot and Full Reset work on localized Windows, RTSS can start with Windows again, and the game scan no longer aborts on a single bad entry.

## Version 1.3.6 highlights

- **Monitoring no longer stays blank.** The LibreHardwareMonitor bridge's first sample (full sensor enumeration) can take longer than the steady-state poll timeout, which made the app kill and restart it every six seconds. The first request after a bridge start now gets a 30-second window, so CPU/GPU temperature, power, VRAM and fan values appear instead of dashes.
- **Start-at-boot, profile delete and Full Reset on non-English Windows.** `reg` and `schtasks` localize their "not found" messages, and the startup code only matched English text. Missing entries are now detected by exit code, so the toggle, profile deletion and the reset snapshot work on German and other localized installs.
- **Start RTSS with Windows can be enabled again.** The RTSS startup check had the same English-only matching; enabling and disabling both work now.
- **Game scan survives a bad entry.** A trailing `.exe` was stripped with a byte slice that panics on names ending in a multi-byte character (for example "Grüße.exe"), and one malformed entry could blank the whole catalog. Each scan phase is isolated, and a failure now names the panic.
- **Also included from 1.3.6:** the Intel oneVPL encoder option with the built-in Quick Sync fallback, installer/update fixes for a locked install folder, boot apply after moving the install, RTSS overlay chip names, single-instance and hotkey grammar, the Arc Power Overlay start fix, and the Highest power plan / Windows Update driver tweaks.
## Upgrading from 1.2.5

Once version 1.3.6 is published on GitHub, the 1.2.5 updater can find it through the existing installer and portable asset names. The upgrade is designed to preserve user data in `%APPDATA%\ArcPower`.

## What Arc Power does

- Tune supported GPU clocks, power limits, voltage offsets, and fan controls.
- Monitor GPU, CPU, memory, frame rate, and frame time data.
- Configure the Arc Power or RTSS in-game overlay, including optional CPU/GPU chip labels, compact value units, and a shared Celsius/Fahrenheit temperature setting.
- Record video and Instant Replay with configurable encoders, CBR/VBR/CQP/ICQ rate control, improved audio capture and replay saving, and a global start/stop recording hotkey.
- Save and apply named profiles, including at Windows logon.
- Adjust supported graphics options and reversible Windows settings.
- Sharpen games and enlarge smaller windowed games with independent Arc Image Sharpening and ASR controls.
- Browse Intel Arc and Arc Pro driver versions in the Driver Library, review release information, and download or remove driver installers.

Controls depend on the capabilities reported by the selected device and its driver. Arc Power does not enable unsupported controls.

## Supported hardware

| GPU | Architecture | Verified support |
|---|---|---|
| Arc A3 / A5 / A7 series | Alchemist | **Verified - Working** |
| Arc B580 / B570 | Battlemage | **Verified - Working** |
| Arc Pro Series| Alchemist & Battlemage & Crescent Island | **Verified - Tweaks & Telemetry only** |
| Arc iGPU | Alchemist & Battlemage | **Verified - Tweaks & Telemetry only** |

### Support status

AMD and NVIDIA adapters may appear for telemetry when their vendor libraries are available. Tuning controls require an Intel Arc GPU.

## Install

Arc Power requires Windows 10 or 11, 64 bit, and an installed Intel graphics driver for Arc features. Download the [latest published release](https://github.com/YamsSE/Arc-Power/releases/latest):

- **Installer:** `Arc-Power_Installer.exe` installs Arc Power and supports elevated apply-at-startup behavior.
- **Portable:** `Arc-Power_Portable.exe` runs without installation.

Both distributed builds request Windows administrator approval at launch.

To run from source, install Node.js 20 or newer:

```bash
npm install
npm start
```

Build the Tauri renderer and compile the Windows release host with your Rust and Windows SDK toolchain. Then package the host with NSIS. The packaging command reads the runtime files directly from this checkout.

```powershell
npm ci --prefix src-tauri/frontend-deps
node scripts/build-tauri-frontend.mjs
cargo build --manifest-path src-tauri/Cargo.toml --locked --release
npm run dist -- src-tauri/target/release/arc-power-tauri.exe dist-tauri/1.3.6
```

## First steps

1. Select the Arc adapter to control if your system has more than one GPU.
2. Use Dashboard for status, Monitoring for live data, and Tuning for supported GPU controls.
3. Choose a value and select Apply. The first overclocking apply requires accepting the warranty notice. Extended ranges require a separate confirmation.
4. Visit Graphics for supported display and frame options, or Tweaks for reversible Windows settings.
5. Open Monitoring, then Overlay to configure the in-game display and its shortcuts.

Profiles can save, load, rename, and delete tuning configurations. Enable Start at boot to apply the active profile when Arc Power starts. Settings include Windows startup behavior, themes, telemetry logging, cache maintenance, and Memory Saving Mode, which is off by default.

The default overlay shortcuts are **CTRL+O** for the Arc Power overlay and **CTRL+P** for the advanced panel. Change them in Overlay settings if another application uses the same shortcut.

## Arc Image Sharpening and ASR

Enable **Arc Image Sharpening** in Graphics and choose a strength from 0% to 100%. In Game Profiles, open the game's Graphics settings, choose an override or Use global, and select **Launch game**. The global switch must be on for per-game sharpening to take effect. A game started normally through Steam or Epic needs to be relaunched through Arc Power before sharpening can attach. RTSS is not required, and Arc Power does not add files to the game's folder or download a sharpening runtime before launch.

For **ASR**, set the game to Windowed mode at a resolution smaller than your display and enable Arc Super Resolution in Graphics or Advanced Overlay. Game Profiles → Graphics also offers **Use global / On / Off**: On enables ASR for that game even with the global default Off, while Off excludes it with the global default On. Keep the game in front while it is enlarged; switching away restores its normal window. ASR works with automatically detected or manually added game executables and does not require launching through Arc Power. Sharpening remains a separate setting and can also be enabled during ASR.

Sharpening's managed launcher currently supports x64 games. The new path was verified with a DX11 fixture and Expedition 33 in DX12 on a B580, including simultaneous ASR and sharpening. Vulkan, DX9, DX10, OpenGL, other display modes, and other games have not been verified by those tests. See the [validation details](docs/managed-sharpening-validation.md) for measurements and limits.

## Safety and troubleshooting

Overclocking can damage hardware and may void warranties. Monitor temperatures, power, and stability. Arc Power uses reported or verified device limits and checks applied values by reading them back. A failed read-back is reported as a failed apply.

VF curve points follow the voltage and frequency steps reported by the driver. Arc Power reads back the complete LIVE curve after each write. An exact match succeeds; a difference of at most one reported driver step per point is shown as a driver adjustment. Larger remaps, unstable read-back, and a write that leaves LIVE unchanged are reported as a failed apply, with the requested draft preserved. B580 curve behavior still needs a successful hardware verification against IGS. Keep both GPU core offsets at zero before applying a custom curve.

- **A control is unavailable:** the selected GPU or driver does not report that capability.
- **An apply requests permission:** approve the Windows UAC prompt. The installed build is recommended for startup applies.
- **The overlay is missing:** enable it in Monitoring, then check the selected GPU, shortcut, and overlay mode.
- **Startup profile did not apply:** select a profile, accept the warranty notice, and enable Start at boot.
- **The interface looks incorrect after an update:** use Settings, Maintenance, then Clear cache and restart.

For diagnostics, enable Log to file in Settings. Telemetry logs are saved in your Documents folder.

## Project links

- [Download Arc Power](https://github.com/YamsSE/Arc-Power/releases)
- [Feature and safety details](docs/features.md)
- [Website](https://yamsse.github.io/Arc-Power/)
- [License](LICENSE)
- [Third-party notices](THIRD_PARTY_NOTICES.txt)

Arc Power is not affiliated with or endorsed by Intel Corporation. OBS integration is powered by [Ascent OBS](https://github.com/judehek/ascent-obs).
