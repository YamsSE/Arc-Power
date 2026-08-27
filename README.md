<p align="center">
  <img src="src/assets/ArcPowerIcon.png" alt="Arc Power" width="120">
</p>

<p align="center">
  <a href="https://github.com/YamsSE/Arc-Power/releases"><img src="https://api.iconify.design/mdi/download.svg?color=%231E9EEB" alt="Download releases" title="Download releases" width="22" height="22"></a>
  <a href="https://discord.gg/nXAjasHy6e"><img src="https://api.iconify.design/simple-icons/discord.svg?color=%235865F2" alt="Join the Discord" title="Join the Discord" width="22" height="22"></a>
</p>

<h1 align="center">Arc Power</h1>

<p align="center"><b>1.0.5</b> - Arc Power: Windows tuning, monitoring, overlay, and profile management for Intel Arc GPUs.</p>

Arc Power provides driver-backed controls for Intel Arc graphics cards, including overclocking, fan control, live telemetry, graphics settings, profiles, and an in-game overlay. Controls are shown only when the selected GPU and driver expose them; unsupported controls remain unavailable or read-only.

## Supported hardware

| GPU | Support |
|---|---|
| Arc A3 / A5 / A7 series (Alchemist) | Verified tuning and monitoring |
| Arc B580 / B570 (Battlemage) | Verified tuning and monitoring |
| Arc Pro Series | Verified tweaks and telemetry; overclocking is driver-locked |
| Arc integrated graphics | Verified tweaks and telemetry; controls depend on the driver |

AMD and NVIDIA adapters remain visible for telemetry when their vendor libraries are available, but Arc tuning requires an Intel Arc GPU.

## Install and start

Requirements:

- Windows 10 or 11, 64-bit
- An Intel graphics driver installed for Arc features
- Administrator approval when Windows requests it

Download the latest release and choose either:

- **Installer** - `Arc-Power_Installer.exe`; recommended for normal use and apply-at-startup.
- **Portable** - `Arc-Power_Portable.exe`; no installation, but applies may require a UAC prompt.

To run from source, install Node.js 20 or newer and use:

```bash
npm install
npm start
```

To build both Windows packages locally:

```bash
npm run dist
```

The files are written to `dist\`.

## Basic usage

1. Select the Arc adapter you want to control when more than one GPU is present.
2. Use **Dashboard** for hardware status and health, **Monitoring** for live graphs and telemetry, and **Tuning** for GPU and fan controls.
3. Change a value and select **Apply**. The first overclocking apply requires accepting the warranty warning; extended values require an additional confirmation.
4. Use **Graphics** for XeSS Frame Generation, frame synchronization, frame limits, low latency, and supported display settings.
5. Use **Tweaks** for reversible Windows graphics options. Each option can be enabled, disabled, or reverted.

### Profiles

**Profiles** can save, load, rename, and delete named tuning configurations. Load a profile to make it active, then enable **Start at boot** to apply it when Arc Power starts. The **Settings** tab also includes Start with Windows, Start minimized, Close to tray, themes, telemetry logging, and cache maintenance.

### Overlay

Open **Monitoring → Overlay** to enable and configure the click-through HUD. It can show clocks, temperatures, power, utilization, VRAM, FPS, 1% Low / 99% FPS, and frame time. Choose its stats, color, theme, scale, background, position, and monitored GPUs.

The default shortcuts are **CTRL+O** for the HUD and **CTRL+P** for the optional advanced panel. The letter for either shortcut can be changed in Overlay settings. If a shortcut is already used by another application, choose a different letter.

## Safety

Overclocking can damage hardware and may void warranties. Monitor temperatures, power, and stability, and use changes appropriate for your card, cooling, and power supply. Arc Power keeps controls within driver-reported or app-verified ceilings, asks for confirmation before extended ranges, and verifies applied values by reading them back from the driver. A failed read-back is reported as a failed apply.

Arc Power is not affiliated with or endorsed by Intel Corporation.

## Troubleshooting

- **“Non supported GPU”** - Arc overclocking needs an Intel Arc GPU. Install or update the Intel graphics driver, restart Arc Power, and select the intended adapter.
- **A control is missing or read-only** - the selected GPU or driver did not report that capability. This is intentional; do not force the setting.
- **An apply needs permission** - approve the UAC prompt. The installed build is the best choice for elevated apply-at-startup behavior.
- **The overlay does not appear** - enable it in **Monitoring → Overlay**, check the selected GPUs and shortcut, and try another CTRL+letter if registration failed.
- **Startup or profile apply did not run** - make sure a profile is active, the warranty prompt has been accepted, and **Start at boot** is enabled. Use the installed build for the most reliable elevated startup apply.
- **The interface behaves oddly after an update** - use **Settings → Maintenance → Clear cache & restart software**. For diagnostics, enable **Log to file** in Settings; daily telemetry logs are saved in your Documents folder.

## Links and notices

- [Releases](https://github.com/YamsSE/Arc-Power/releases)
- [Feature and safety details](docs/features.md)
- [License - GPL-2.0](LICENSE)
- [Third-party notices](THIRD_PARTY_NOTICES.txt)
