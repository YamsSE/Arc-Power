# LibreHardwareMonitor telemetry

Arc Power uses the `LibreHardwareMonitorLib` 0.9.6 net472 release payload,
pinned to upstream revision
`3d331e3370efb858411f19511373eff65a218701`,
through the read-only `ArcPower.LhmBridge.exe` JSON-lines helper. The helper
is isolated from Electron because the LHM library is managed .NET code and
some sensors require elevated hardware access.

The bridge reports CPU, memory, and GPU sensors. Arc Power does not use LHM's
GPU load sensors: GPU utilization comes from the Windows GPU Engine counter,
and FPS/frametime comes from RTSS. GPU matching uses the PCI device id and
refuses ambiguous duplicate models; it never binds a physical adapter by
enumeration ordinal.

To rebuild the vendored bridge, obtain the exact `LibreHardwareMonitor.zip`
asset from the v0.9.6 release and run:

```powershell
& .\build\build-lhm-bridge.ps1 `
  -LibreHardwareMonitorDirectory C:\path\to\LibreHardwareMonitor-net472
```

Upstream source: https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/tree/3d331e3370efb858411f19511373eff65a218701

LibreHardwareMonitor is distributed under MPL-2.0. See
`LICENSES/MPL-2.0.txt` and the LibreHardwareMonitor entry in
`THIRD_PARTY_NOTICES.txt`.
