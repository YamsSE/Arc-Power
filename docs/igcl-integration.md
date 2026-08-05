# IGCL Integration — M0 probe findings (Arc A770)

Date: 2026-08-05 (local, W. Europe / UTC+2 — the probe stamps `meta.generatedAt` in UTC, so artifacts from
this run read 2026-08-04T22:xxZ, i.e. 2026-08-05 00:xx local). Re-run after the step-4 review fixes and the
step-5 round-1 fixes, same driver 32.0.101.8861. Probe: `tools/probe/` (Node 24 + koffi, no C++ toolchain).
Outputs: `tools/probe/out/*.json`.

## 1. The native runtime DLLs (the key discovery of M0)

There are **two** IGCL DLLs, with different roles and different UID policies:

| DLL | Size | Role | UID policy on this driver |
|---|---|---|---|
| `ControlLib.dll` (System32 + driver package) | 308 KB | **Loader** — locates the runtime via `GetControlLibRTPath` (registry `System\CurrentControlSet\Enum...`), then dispatches | **Strict whitelist**: rejects every UID that is not Intel-registered, including all-zeros → `CTL_RESULT_ERROR_UNKNOWN_APPLICATION_UID (0x40000021)` |
| `IntelControlLib.dll` (driver package only) | 743 KB | **Runtime** ("Intel Graphics Control Lib Runtime for Intel Graphics", v1.2.291.0, Intel Corporation) | **Accepts the all-zeros default UID** (same as Intel's samples / LibreHardwareMonitor). Invented/non-registered UIDs are rejected on this driver (`0x40000021`) — treat **all-zeros** as the safe default. (The 8/4 run accepted the invented 'RIDAPOW!' UID; re-verification on 8/5 consistently rejects it — do not rely on invented UIDs.) |

Exact paths found on this machine (2026-08-04):

```
C:\Windows\System32\ControlLib.dll                          (loader; version 1.2.291.0; SHA256 64BB1906…)
C:\Windows\System32\DriverStore\FileRepository\
  iigd_dch_d.inf_amd64_44a9322a912c6447\ControlLib.dll      (loader; identical hash to System32)
  iigd_dch_d.inf_amd64_44a9322a912c6447\IntelControlLib.dll (runtime; ACTIVE driver 32.0.101.8861, 2026-07-05)
  iigd_dch_d.inf_amd64_090b7c5495907f9a\IntelControlLib.dll (runtime; staged 32.0.101.8864, 2026-07-17 — NOT active)
```

Note the second folder: a newer package (8864) is present in the DriverStore but the **active** driver is 8861 — the DriverStore keeps staged/rolled-back packages, so "newest folder" is not a reliable selector (see below).

The IGS .NET wrapper (`C:\Program Files\Intel\Intel Graphics Software\IntelGraphicsSoftware.Wrapper.IGCL.dll`)
loads the **loader** by name (`kControlLibName` constant in its native `createInitArgs` code), which is why
IGS works — it uses an Intel-registered UID.

**Decision for M0/M1: load `IntelControlLib.dll` directly** (it is the documented public API runtime, ships in
every driver package, and accepts the default all-zeros application UID, exactly like Intel's own samples and
LibreHardwareMonitor). The loader path is unusable without a registered UID; registering one with Intel is a
long-lead item and not needed since the runtime is directly loadable. See also §7.

Dependencies: the runtime imports only system DLLs (`advapi32`, `cfgmgr32`, `d3d11`, `dxgi`, `gdi32`, `kernel32`,
`ntdll`, `shell32`, `user32`) plus its own name — no sidecar DLLs. Level Zero is resolved **at runtime** (see §5).

### Locating the runtime robustly
`IntelControlLib.dll` is *not* in System32 — only inside the DriverStore `iigd_dch_d.inf_amd64_<hash>` folder,
whose hash changes per driver install, and which accumulates packages from several installs.
`tools/probe/igcl.mjs::findIgclDll()` scans `C:\Windows\System32\DriverStore\FileRepository\iigd_dch_d.inf_amd64_*`
and selects, in order:
1. the package whose INF `DriverVer` matches the **active** display driver version (read from the display
   class registry key `HKLM\...\Control\Class\{4d36e968-...}` — the driver block is picked from the
   discrete-GPU (`Arc`) `DriverDesc` when one exists, falling back to the last Intel block, then the last
   block; this is what correctly disambiguates staged vs. active packages and iGPU vs. dGPU subkeys,
   e.g. 8864 vs. 8861 above);
2. the most recently written package (fallback);
3. `IGCL_DLL_PATH` env var, then System32 `ControlLib.dll` (loader — `ctlInit` then fails with a clear
   `ERROR_UNKNOWN_APPLICATION_UID`), then System32 `IntelControlLib.dll` (runtime, if one was ever copied
   there), then the IGS install dir.

DriverStore listing and the display-class key require no elevation on this machine (standard user, Node
process). Note: the DriverStore also contains `.ini` metadata *files* with the same `iigd_dch_d.inf_amd64_*`
prefix (one per package) — the scan requires `IntelControlLib.dll` to exist in the folder, which excludes
them. If nothing is found the probe aborts with a descriptive error.

## 2. Init arguments (probe-verified)

```
Size            = 36 (sizeof ctl_init_args_t, MSVC x64)
Version         = 0
AppVersion      = CTL_MAKE_VERSION(1,1) = 0x00010001   (IGCL header v1.1)
flags           = CTL_INIT_FLAG_USE_LEVEL_ZERO (0x1)
SupportedVersion= out — 0x00010001 observed on success
ApplicationUID  = {0x52494441,'RC','PO',"RIDAPOW!"}     (invented — REJECTED on the current driver; the probe falls back to all-zeros, which the runtime accepts — use zeros for the product)
```

On the current driver (32.0.101.8861) the invented UID is rejected with `ERROR_UNKNOWN_APPLICATION_UID`;
the probe then retries with the all-zeros UID. `ctlInit` (zero UID) → **SUCCESS**; `ctlClose` →
`CTL_RESULT_SUCCESS_STILL_OPEN_BY_ANOTHER_CALLER (0x1)` because the IGS service also holds the runtime open —
harmless and expected.

## 3. Struct mapping table (C → koffi), MSVC x64

All sizes asserted at load time in `igcl.mjs` (a header/driver change that alters a size aborts with a clear
message instead of silently misparsing).

| C struct | Size | koffi definition notes |
|---|---|---|
| `ctl_application_id_t` | 16 | Data1 u32, Data2/3 u16, Data4 u8[8] |
| `ctl_init_args_t` | 36 | Size@0, Version@4, AppVersion@8, flags@12, SupportedVersion@16, ApplicationUID@20 |
| `ctl_firmware_version_t` | 24 | 3×u64 |
| `ctl_device_adapter_properties_t` | **320** | pDeviceID@8 (void*), driver_version@32 (u64), firmware_version@40, name char[100]@88, Frequency@192, pci_subsys_id@196 (u16), adapter_bdf@200 (3×u8), num_xe_cores@204, reserved u8[108]@208 |
| `ctl_oc_control_info_t` | 48 | 3×bool@0, units@4 (int32), then 5×double@8 |
| `ctl_oc_properties_t` | 440 | Size,Version,bSupported@5, then 9 × `ctl_oc_control_info_t`@8 |
| `ctl_oc_vf_pair_t` | 24 | Size,Version,Voltage double,Frequency double |
| `ctl_fan_speed_t` | 16 | Size,Version,speed int32@8,units@12 |
| `ctl_fan_temp_speed_t` | 28 | Size,Version,temperature u32@8,speed@12 |
| `ctl_fan_speed_table_t` | 908 | Size,Version,numPoints int32@8,table[32]@12 |
| `ctl_fan_properties_t` | **24** | Size,Version,canControl bool@5, then 4×u32@8 (bool stays 1 byte: 2 pad bytes before supportedModes) |
| `ctl_fan_config_t` | 936 | Size,Version,mode@8,speedFixed@12,speedTable@28 |
| `ctl_oc_telemetry_item_t` | 24 | bSupported bool,units int32,type int32,value 8B union (declared `double`; re-decoded as u64/i64 for `UINT64` items) |
| `ctl_psu_info_t` | 56 | bool,int32,item,item |
| `ctl_power_telemetry_t` | 1024 | Size,Version, then items; 5×bool throttle flags; psu[5]@408; fanSpeed[5]@688; 9 extra v1 items |
| `ctl_voltage_frequency_point_t` | 8 | Voltage u32, Frequency u32 |

Padding traps hit: `ctl_fan_properties_t` (24 not 28 — the bool does not get 4-byte padding), and the
`ctl_device_adapter_properties_t` tail (u16 + 3×u8 + pad + u32 + reserved). koffi reproduces MSVC alignment
automatically; the assertion table above is what keeps it honest.

koffi notes: `lib.func()` *returns* the callable (it is not attached as `lib.<name>`); out-params are passed as
`koffi.alloc(type, n)` buffers and read with `koffi.decode(ptr, type)` or `koffi.decode(ptr, offset, type)`
(offset is the **second** argument); `koffi.encode(ptr, type, obj)` writes initial values; `koffi.offsetof`
gives field offsets for the telemetry union re-decode.

## 4. A770 capability matrix (driver 32.0.101.8861)

Device: `Intel(R) Arc(TM) A770 Graphics`, PCI 8086:56A0 rev 8, 32 Xe cores, graphics clock 2100 MHz,
driver_version `0x002000000065229d`. Full dump: `tools/probe/out/a770-capabilities.json`.

| Control | bSupported | Units | Min | Max | Step | Default |
|---|---|---|---|---|---|---|
| gpuFrequencyOffset | ✅ | FREQUENCY_MHZ | 0 | 300 | 1 | 0 |
| gpuVoltageOffset | ✅ | VOLTAGE_VOLTS | 0 | 0.234 | 0.005 | 0 |
| powerLimit | ✅ | **POWER_WATTS** (units=4, not mW!) | 105 | 252 | 1 | 210 |
| temperatureLimit | ✅ | TEMPERATURE_CELSIUS | 60 | 90 | 1 | 90 |
| vramFrequencyOffset | ❌ | — | | | | |
| vramVoltageOffset | ❌ | — | | | | |
| vramMemSpeedLimit | ❌ | — | | | | |
| gpuVFCurveVoltageLimit | ❌ | — | | | | |
| gpuVFCurveFrequencyLimit | ❌ | — | | | | |

> **M1 implication: always read `units` and convert in the UI.** The capability field reports power in
> **watts** and voltage in **volts** on this A770 (not mW/mV), contradicting the plan's "power limit in mW"
> assumption. The backend must carry per-control units from `ctl_oc_properties_t` and the UI must
> render/clamp in those units.
> VRAM overclocking and VF-curve are **not exposed** by this driver on the A770 (Get returns
> `CTL_RESULT_ERROR_UNSUPPORTED_FEATURE`).

**Per-API unit contract (pinned, verified against the official header):** the V1 OC get/set pair is
**fixed-unit** — `ctlOverclockPowerLimitGet/Set` is hardcoded **mW** (observed read-back 252000) and
`ctlOverclockGpuVoltageOffsetGet/Set` is hardcoded **mV**; `ctl_oc_properties_t` units do **not** apply to
them. The **V2** pair follows the capability matrix — `ctlOverclockPowerLimitGetV2/SetV2` uses
`powerLimit::units` and `ctlOverclockGpuMaxVoltageOffsetGetV2/SetV2` uses `gpuVoltageOffset::units`
(W / V on this A770 — observed V2 power read-back 252 W; voltage-offset
capability max 0.234 V; the header notes the units "can be different for different
generation of graphics product"). **M1 must use the V2 APIs plus capability-unit conversion.**

## 5. Level Zero

- `ze_loader.dll` present at `C:\Windows\System32\ze_loader.dll` (≈966 KB) and in the driver package.
- `ctlInit` with `CTL_INIT_FLAG_USE_LEVEL_ZERO` succeeded; `SupportedVersion=0x00010001` returned.
- The runtime does not statically import `ze_loader.dll` — it loads it dynamically at init; a missing loader
  would surface as `CTL_RESULT_ERROR_ZE_LOADER (0x40000019)` at `ctlInit`. Not hit here.

## 6. Fan findings

- `ctlEnumFans` → 1 fan. Properties: `canControl=false`, `supportedModes=0x2` (FIXED only), `supportedUnits=RPM`,
  `maxRPM=-1` (unknown), `maxPoints=10`.
- `ctlFanGetConfig` → mode **TABLE** with 10 points (20°C→20% … 90°C→100%; speeds reported in **PERCENT**
  even though supportedUnits claims RPM), fixed speed = 0 RPM (no fixed mode set).
- `ctlFanGetState(RPM)` → **~1030 RPM** idle (1029–1036 across runs); `ctlFanGetState(PERCENT)` →
  `ERROR_UNSUPPORTED_FEATURE`.
- Telemetry `fanSpeed[0]` → same RPM as `ctlFanGetState` (consistent).
- **`canControl=false` means fan mode/curve/fixed setters are gated on this card** — M1 must read
  `canControl` and degrade the Fan page to read-only if false (A770 board/BIOS may not grant control; IGS may
  also be holding it — investigate whether toggling IGS "fan control" changes this bit in M2 cross-validation).

## 7. koffi vs sidecar — DECISION: koffi

**Verdict: koffi.** The full OC/fan/telemetry surface marshalled cleanly on the first end-to-end run; struct
sizes are asserted and stable; no ABI pain encountered (the only "trap" was choosing the right DLL, not the
binding). The .NET sidecar fallback stays as planned (driver evolution + P/Invoke parity), but there is no
current reason to prefer it. Note for M1: Electron main-process `koffi.load` must use the DriverStore-located
`IntelControlLib.dll` path (§1) — not a bare `ControlLib` name.

Open items that *would* force the sidecar: if a future driver stops shipping `IntelControlLib.dll` or begins
enforcing the UID whitelist inside the runtime itself.

## 8. Safety & state-leaving notes

- Waiver: `ctlOverclockWaiverSet` → SUCCESS. Allowed in the headless probe (developer's own machine); product
  code must keep the user-acceptance gate (plan §5).
- No-op applies: for each supported control, Get → Set(same value) → Get. All 8 round trips
  (4 controls × V1/V2) returned SUCCESS and the read-back matched the original value exactly
  (power limit read-back: V1 252000 mW vs V2 252 W — the per-API unit contract, §4). Unsupported
  controls (VRAM*) error on Get with `0x4000000A` — recorded, never set.
- `gpuFrequencyOffset` currently reads **48.30 MHz** (identical across runs, V1 and V2) while the capability
  default is 0 — the offset is set by IGS/driver, not by the probe; the probe writes it back unchanged.
- `ctlOverclockGpuLockGet` → 0/0 (dynamic); the set was skipped by safety rule (writing 0,0 would switch
  modes), no lock was active.
- VF curve read (`STOCK`/`LIVE`, ELABORATE) → `CTL_RESULT_ERROR_DATA_READ (0x40000012)` — the A770 driver
  does not expose VF curves through this API; expected on Alchemist, revisit on Battlemage (M4).
- `ctlOverclockResetToDefault` was **not** called — the probe changed nothing (`changed=false`).
- `ctlClose` returned `SUCCESS_STILL_OPEN_BY_ANOTHER_CALLER` (IGS service holds the runtime) — clean shutdown.

## 8a. IGS service blocks OC writes (verified 2026-08-05, driver 32.0.101.8861)

**Decisive experiment** (M2a diagnostics): while `IntelGraphicsSoftwareService` is **Running** and IGS
has no OC values applied, IGCL OC setters for power/freq/temp are silently refused
(`ctlOverclockGpuFrequencyOffsetSet` returns SUCCESS but the read-back never changes; setting 0
returns undocumented `0x40000007 ERROR_NOT_AVAILABLE`; `PowerLimitSet` returns SUCCESS but is
ignored). The IGCL spec documents NO enable step beyond the waiver (the waiver is accepted, 0x0);
the official Overclocking sample (github.com/intel/drivers.gpu.control-library, master) uses exactly
our call sequence and no more. `CTL_INIT_FLAG_IGSC_FUL` and `ctlSetRuntimePath`/`UnlockID` are
documented for firmware-update/Intel-loader use — not OC enablement.

**With `IntelGraphicsSoftwareService` stopped** (elevated `Stop-Service`, then restart), ALL OC
writes work immediately: powerLimit 252 W, gpuFreqOffset +5 MHz, gpuVoltOffset +0.01 V all
set-and-read-back verified, and restore to defaults works. Service restarted afterwards; the
blockade returned (causality confirmed in both directions). `gpuVoltOffset` is the only control
that works with the service running.

Implications:
- The KMD/IGCL path is healthy; the IGS service is the blocker (it enforces/reverts OC state).
- Arc Power works fully when the IGS service is stopped/disabled; with it running, power/freq/temp
  applies fail honestly via read-back (`io-failed` toasts in the UI).
- Product note (M2b+): when applies fail, the UI should hint at the IGS service (documented
  workaround), and the dist smoke should be run with the service stopped or IGS OC engaged.

**Update (same day, after the M2a.5 disable-button feature):** the picture is more complex than
"the service is the blocker". With the service DISABLED (via the app's elevated button), the IGS
app processes killed, and nothing Intel-related running, power/freq/temp writes still flapped:
applied-and-verified at 06:36, refused (SUCCESS-but-ignored / 0-set → 0x40000007) at 06:40,
reproduced repeatedly. `ctlOverclockResetToDefault` failed with `0x40000013 ERROR_DATA_WRITE`
while refused. Voltage offset remained writable throughout.

Evidence-based conclusion:
1. The IGCL apply path in Arc Power is correct (voltage offset applies reliably; all four
   controls applied and read-back-verified when the KMD accepts).
2. The A770 driver (32.0.101.8861) has an OC-acceptance state machine that oscillates on its
   own (minutes-scale), independent of IGS: with IGS running it was mostly blocked; with IGS
   fully removed it still flapped.
3. The app never lies: refused writes surface as `io-failed` per-control toasts.
4. Open question: does a reboot clear the oscillation for a stable window? (Not yet tested —
   recommended next step; the M2a dist smoke cannot pass reliably while the driver flaps.)

## 9. Telemetry findings

3 samples at ≥50 ms spacing (measured ~61–64 ms). Derived idle GPU power ≈ **38.8 W** on the final fix
run (energy-counter deltas; 37.5–39.7 W across all runs — the exact figure moves with machine state), GPU
clock 600 MHz, temp 36 °C, VRAM clock 2000 MHz / effective 16000 MHz,
VRAM temp 44 °C, gpu voltage 0.652 V, fan ~1030 RPM.
Supported items: **13 of the 25 item fields, plus `fanSpeed[0]`** (telemetry sub-array, same RPM as
`ctlFanGetState`) — timeStamp, gpuEnergyCounter, gpuVoltage (0.652 V), gpuCurrentClockFrequency,
gpuCurrentTemperature, globalActivityCounter, renderComputeActivityCounter, mediaActivityCounter,
vramCurrentClockFrequency, vramCurrentEffectiveFrequency, vramReadBandwidthCounter (UINT64),
vramWriteBandwidthCounter (UINT64), vramCurrentTemperature. **PSU items unsupported** on this
card (bSupported=false). Throttle flags all false at idle. Full dump: `tools/probe/out/telemetry.json`.

## 10. Risks for M1

1. **DriverStore path stability** — `IntelControlLib.dll` must be located by scanning; document that a driver
   update changes the folder hash (findIgclDll re-scans every launch; fall back to System32
   `ControlLib.dll`/`IntelControlLib.dll`, then the IGS dir, with a clear "unregistered UID" error if only
   the loader is found).
2. **Units surprise** — the capability matrix and the V2 get/set APIs report power in W / voltage in V on
   this A770 (V1 is fixed mW/mV); UI and `Settings` schema must be units-aware end to end (the plan's mW
   assumption is wrong for this hardware).
3. **Fan `canControl=false`** — fan control likely unavailable via IGCL on this card; the Fan page must be
   read-only and M2 must check whether IGS's own fan toggle flips the bit.
4. **VRAM/VF-curve unsupported** — expert controls hidden on Alchemist; keep code paths for Battlemage (M4).
5. **Loader vs runtime** — if a future driver drops the open runtime, we need a registered UID (Intel process)
   or the sidecar. Mitigation: probe re-run on driver updates (add to M4 hardening checklist).
6. **`ctlOverclockGetProperties` Version=1** — vramMemSpeedLimit/VF-curve limit fields exist only at
   Version ≥ 1; the probe passes 1 (matching Intel's sample). Confirm on Battlemage.
7. **Telemetry cadence** — samples <50 ms apart return stale/cached data; TelemetryService must enforce the
   rate (500 ms poll is fine).
