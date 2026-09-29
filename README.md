# Arc Power 1.2

Arc Power is an open source Windows application for Intel Arc GPU tuning, monitoring, and control. Version 1.2 includes the Driver Library, which lets you browse available Intel driver releases and manage downloaded installers.

## What Arc Power does

- Tune supported GPU clocks, power limits, voltage offsets, and fan controls.
- Monitor GPU, CPU, memory, frame rate, and frame time data.
- Configure the Arc Power or RTSS in-game overlay.
- Save and apply named profiles, including at Windows logon.
- Adjust supported graphics options and reversible Windows settings.
- Browse Intel Arc and Arc Pro driver versions in the Driver Library, review release information, and download or remove driver installers.

Controls depend on the capabilities reported by the selected device and its driver. Arc Power does not enable unsupported controls.

## Supported hardware

| GPU | Architecture | Verified support |
|---|---|---|
| Arc A3 / A5 / A7 series | Alchemist | **Verified - Working** |
| Arc B580 / B570 | Battlemage | **Verified, with B580 VF writes currently blocked on driver 32.0.101.9033** |
| Arc Pro B50 | Battlemage (pro) | **Verified - Tweaks & Telemetry only** |
| Arc iGPU | Alchemist & Battlemage | **Verified - Tweaks & Telemetry only** |

- [x] Battlemage enablement (live verification on B580 / B570)

AMD and NVIDIA adapters may appear for telemetry when their vendor libraries are available. Tuning controls require an Intel Arc GPU.

## Install

Arc Power requires Windows 10 or 11, 64 bit, and an installed Intel graphics driver for Arc features. Download the latest [Version 1.2 release](https://github.com/YamsSE/Arc-Power/releases/latest):

- **Installer:** `Arc-Power_Installer.exe` installs Arc Power and supports elevated apply-at-startup behavior.
- **Portable:** `Arc-Power_Portable.exe` runs without installation. Some hardware changes may request administrator approval.

To run from source, install Node.js 20 or newer:

```bash
npm install
npm start
```

Build the Windows packages with:

```bash
npm run dist
```

## First steps

1. Select the Arc adapter to control if your system has more than one GPU.
2. Use Dashboard for status, Monitoring for live data, and Tuning for supported GPU controls.
3. Choose a value and select Apply. The first overclocking apply requires accepting the warranty notice. Extended ranges require a separate confirmation.
4. Visit Graphics for supported display and frame options, or Tweaks for reversible Windows settings.
5. Open Monitoring, then Overlay to configure the in-game display and its shortcuts.

Profiles can save, load, rename, and delete tuning configurations. Enable Start at boot to apply the active profile when Arc Power starts. Settings include Windows startup behavior, themes, telemetry logging, and cache maintenance.

The default overlay shortcuts are **CTRL+O** for the Arc Power overlay and **CTRL+P** for the advanced panel. Change them in Overlay settings if another application uses the same shortcut.

## Safety and troubleshooting

Overclocking can damage hardware and may void warranties. Monitor temperatures, power, and stability. Arc Power uses reported or verified device limits and checks applied values by reading them back. A failed read-back is reported as a failed apply.

Custom VF curve writes are currently disabled for the Arc B580 on Intel driver 32.0.101.9033. Safe live tests showed the driver remapping the curve, and a STOCK restore could not be verified. Arc Power keeps the live curve readable and refuses changed-curve writes on this driver build.

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
