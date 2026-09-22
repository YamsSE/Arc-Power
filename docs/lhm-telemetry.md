# LibreHardwareMonitor telemetry

Arc Power uses the `LibreHardwareMonitorLib` 0.9.6 net472 release payload,
pinned to upstream revision
`3d331e3370efb858411f19511373eff65a218701`,
through the read-only `ArcPower.LhmBridge.exe` JSON-lines helper. The helper
is isolated from Electron because the LHM library is managed .NET code and
some sensors require elevated hardware access.

The bridge reports CPU, memory, and GPU sensors. For displayed GPU utilization,
Arc Power uses the fresh per-adapter Windows GPU Engine counters and follows
the Task Manager busiest-engine policy. For Intel discrete Arc GPUs, LHM's
Intel GCL device-wide `GPU Core` load sensor is retained as a fallback only
when the Windows value is unavailable and the current GPU inventory proves a
unique PCI vendor/device match and exact stable adapter key. LHM's GPU
identifier does not include BDF/LUID, so a single LHM row is not enough to
distinguish two identical cards. Component `GPU Render/Compute`, `GPU Media`,
and `GPU Memory` load sensors are not substitutes for total GPU load. FPS and
frametime come from RTSS. GPU matching never binds a physical adapter by
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
