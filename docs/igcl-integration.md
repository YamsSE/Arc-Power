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

- `ctlEnumFans` → 1 fan. Properties: `canControl=false`, `supportedModes=0x2` (the FIXED bit — but see the M3-D verdict below: live behavior contradicts it), `supportedUnits=RPM`,
  `maxRPM=-1` (unknown), `maxPoints=10`.
- `ctlFanGetConfig` → mode **TABLE** with 10 points (20°C→20% … 90°C→100%; speeds reported in **PERCENT**
  even though supportedUnits claims RPM), fixed speed = 0 RPM (no fixed mode set).
- `ctlFanGetState(RPM)` → **~1030 RPM** idle (1029–1036 across runs); `ctlFanGetState(PERCENT)` →
  `ERROR_UNSUPPORTED_FEATURE`. Fan STATE reads are RPM-only (supportedUnits=0x1 = RPM); table mode
  SPEAKS percent (the `ctl_fan_speed_t.units` field carries the FAN enum's PERCENT = 1).
- Telemetry `fanSpeed[0]` → same RPM as `ctlFanGetState` (consistent).
- **M3-D verdict (2026-08-06): `canControl=false` is a LIE on this card.** The driver honors
  `ctlFanSetSpeedTableMode` + `ctlFanSetDefaultMode` when the table uses the FAN enum's PERCENT units
  (1 — NOT the general `CTL_UNITS.PERCENT` 11; earlier probes failed on exactly this) and Intel's
  sample encoding (Size/Version filled, points ascending). Proven live twice (a 10-point sample table
  and a realistic 4-point curve: SUCCESS, exact read-back, restore-to-default clean). Fixed-mode
  writes are genuinely unsupported (ERROR_UNSUPPORTED_FEATURE), so the shipped `1<<mode` derivation
  from `supportedModes=0x2` (→ `['fixed']`) is wrong on this card — the backend's reversible probe
  (run once per device per session inside the first `getCapabilities`, promise-cached OUTSIDE the
  caps cache) learns the real modes `['auto','curve']` whenever the probe WRITE is accepted —
  probe-ok, and also probe-fail after an accepted write (stuck restore / IGS reapply race); a
  write-REFUSED probe keeps the derived modes (claiming auto/curve on a genuinely fixed-only card
  would lie). The probe runs when properties refuse control AND when they grant it but the derived
  modes claim `'fixed'` (the one mode this card refuses; with IGS running `canControl=TRUE` and the
  wrong derivation would still gate the Fan page to fixed-only). The effective fan gate is
  `properties.canControl || probeOk`.

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
- Product note (M2b+): the verified rule is **IGS fully off OR fully on** — OC writes are
  refused in the half-states (IGS service running without the app, or the app running
  without the service); fully-on (app + service, Tuning tab enabled) and fully-off both
  work. The UI hints at this state when applies fail, and the dist smoke should be run
  with IGS fully off or fully on.

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

**Update 2 (06:45, after re-enabling the service):** with the service re-enabled (Manual +
Running) and the IGS app open, all four OC writes applied and read-back-verified again
(252 W, +5 MHz, +0.01 V, then restored to defaults) — yet the packaged smoke 2 minutes later
failed its no-op 0-value applies (`ERROR_NOT_AVAILABLE`). Combined with the earlier data
(worked at 06:36 with nothing running; refused at 06:40 with nothing running), the conclusion
is: **no hard dependency on IGS either way** — the A770 driver's OC-write acceptance
oscillates on a minutes scale. Non-zero offset sets (and voltage offset generally) are more
often accepted than 0-value no-op sets, which is why the no-op smoke gate is the first thing
to go red. Product note for M2b: a retry-with-backoff on `io-failed` applies, and a
"driver busy — retry" hint, would mask most of this for real users.

**Update 3 (M2a.6, same day):** the half-state matrix was verified — with the service
running and the IGS app closed, OC writes are refused; with the service stopped but the
app running, refused as well. Fully on (service + app, Tuning tab enabled) and fully off
both accept writes. The app now detects both halves (service state via `sc.exe`, app
process via `tasklist /FO CSV /NH /FI "IMAGENAME eq IntelGraphicsSoftware.exe"`) and
warns on the half-states with the rule: IGS must be fully disabled OR fully running.

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
3. **Fan `canControl=false`** — RESOLVED (M3-D, 2026-08-06): the property is a lie on this card; the
   reversible probe (FAN-enum PERCENT table encoding) unlocks table/default writes and the Fan page is
   editable. The probe is a single write+restore per session, restore-retried, never left in table mode.
4. **VRAM/VF-curve unsupported** — expert controls hidden on Alchemist; keep code paths for Battlemage (M4).
5. **Loader vs runtime** — if a future driver drops the open runtime, we need a registered UID (Intel process)
   or the sidecar. Mitigation: probe re-run on driver updates (add to M4 hardening checklist).
6. **`ctlOverclockGetProperties` Version=1** — vramMemSpeedLimit/VF-curve limit fields exist only at
   Version ≥ 1; the probe passes 1 (matching Intel's sample). Confirm on Battlemage.
7. **Telemetry cadence** — samples <50 ms apart return stale/cached data; TelemetryService must enforce the
   rate (500 ms poll is fine).

## 8b. F3 instant apply + temp-limit clamp (M2C-A clamp, M2C-B instant revision 2026-08-05)

**Design (user-constrained, 2026-08-05):** the fix must NOT require any
additional programs to be running and must work for clock/voltage offsets AND
power limit AND temp limit. Evidence basis: IGS fully ON = 100% apply success
(E4c); IGS OFF = PL/PT silent no-op (SUCCESS + read-back unchanged; E4a) with
minute-scale flaps that open on their own. Therefore F3 never starts or stops
IGS from code.

**M2C-B revision (user feedback 2026-08-05):** the retry loop + progress UI
are REMOVED entirely (the harness proved retries never changed the off-window
outcome - freq/PL 0/3 with retries, IGS-on 100% single attempt). New design:
ONE attempt, instant result, honest per-control error with an actionable
driver-refusal message.

- Outcome per control (shared core `src/main/apply-once.js`, `applyOnce`  -  the
  seam where UI Apply, tray apply and apply-on-startup converge): `ok` (set +
  read-back match) / `hard` (OUTSIDE_RANGE family 0x44000004/05/06/07,
  waiver-not-set, invalid-argument 0x4000000b, unsupported  -  instant honest
  failure, errorCode kept, renderer maps via `errorMessage`) / `refusal`
  (io-failed incl. NOT_AVAILABLE 0x40000007, and the SILENT NO-OP: SUCCESS
  returned but read-back unchanged  -  flagged `silentNoop` by the backend,
  NEVER reported "applied"; fails instantly with a composed message).
- Refusal message (composed against the live IGS state, `refusalMessage`):
  powerLimit/freq refusals (and silent no-ops on those controls) with IGS NOT
  fully on name the IGS-on requirement ("...power and frequency writes need
  Intel Graphics Software running - start IGS and apply again"); every other
  refusal gets the plain driver message; with IGS fully on (rare) plain +
  error code.
- Removed with the revision: `apply:progress` events, the "Applying - retry
  N/9" label, `apply-cancel` IPC, the backoff scheduler, `APPLY_MAX_RETRIES`,
  budgets, the "Applied on retry" note and the give-up summary.
- **PT range fix (kept):** the driver setter refuses temp limits above 90 C with
  0x44000005 even in the fully-on window (E4c: TL 92 ? 0x44000005 both V1 and
  V2; the 92 entered the pipeline via the E4 battery/plan test value, the
  product always clamped to the capability max). The exposed max is now
  pinned to 90 C (`TEMP_LIMIT_MAX_C` in `units.js`, applied in
  `igcl-backend.getCapabilities` + backend apply clamp + renderer
  `clampExposedRange` for sliders/presets + main-process validation).

**Harness (`tools/validate/m2c-acceptance.js`, gitignored):** battery
{volt +0.02 V, freq +100 MHz, PL 252 W, TL 90 C} applied one at a time through
the real F3 core, plus a RAW 300 W cell (direct IGCL V2 set bypassing the
product clamp) to prove the cap. Every attempt records timestamp, IGS state,
control, value, result (ok / code / silent-noop), read-back, elapsed.

**Off-window results (3 sessions, IGS fully off  -  run 2026-08-05):**

| control | accepted/total | accept rate | silent no-ops | dominant outcome |
|---|---|---|---|---|
| gpuVoltOffsetV +0.02 | 3/3 | 100% | 0 | applied, read-back 0.02 |
| gpuFreqOffsetMhz +100 | 0/3 | 0% | 3 | io-failed after 4 retries (15 s), read-back stayed 0 |
| powerLimitW 252 | 0/3 | 0% | 3 | io-failed after 4 retries (15 s), read-back stayed 200 |
| tempLimitC 90 | 3/3 | 100% | 0 | same-value no-op (device already at 90) |

Raw 300 W cell: **0x44000004 ERROR_CORE_OVERCLOCK_POWER_OUTSIDE_RANGE in all 3
sessions** (read-back unchanged)  -  the 252 W cap is enforced at runtime for
the zero-UID client; no userspace path exists (matches E0/E1/plan verdict,
user signed off 2026-08-05).

Session hygiene: `ctlOverclockResetToDefault` fails with 0x40000013
DATA_WRITE in the off window (documented E5 behavior)  -  the harness restores
the as-found baseline per control instead; final state == as-found baseline in
all 3 sessions; IGS start/end stopped + disabled + no app (restore verified).

**On-window sessions:** COMPLETED 2026-08-05 12:32 (elevated user-run, one
UAC approval; full log pipeline/run-m2c-acceptance.log). Sessions 4-6,
IGS fully on: all four controls 100% accepted with read-back match, single
attempt each; raw 300 W refused 0x44000004 in all 3 on-sessions (and all
3 off-sessions - cap enforced at runtime in every window). Teardown
restored the service to STOPPED + DISABLED + no app (verified in the log).

| control | off (s1-3) | on (s4-6) |
|---|---|---|
| gpuVoltOffsetV | 3/3 ok | 3/3 ok |
| gpuFreqOffsetMhz | 0/3 (3 silent no-ops) | 3/3 ok |
| powerLimitW | 0/3 (3 silent no-ops) | 3/3 ok |
| tempLimitC | 3/3 ok | 3/3 ok |
| raw 300 W | 0x44000004 x3 | 0x44000004 x3 |

The harness table aggregates all completed sessions
(`node tools/validate/m2c-acceptance.js --table`).


## 8c. M2C-C: the elevation gate + the extended range via the bundled 2023 IGCL runtime (2026-08-05)

### The root-cause revision: the gate is ELEVATION, not IGS state

The M2C-A/B "IGS fully on = 100% success / IGS off = refusal" story was
WRONG. Live-machine diagnosis (driver 32.0.101.8861, elevated vs
non-elevated probes, delayed read-backs, tools/validate/m2c-elev-*.js):

- **Non-elevated IGCL OC writes NEVER persist.** The setter returns SUCCESS
  and an IMMEDIATE read-back matches, then the value reverts � the
  "momentary lie". Every earlier "success" (the M2C-B harness on-window
  100%, all M2a cross-validations) was this lie: never persistence-verified
  with a delayed read.
- **Elevated writes STICK** for every control, with IGS fully on AND fully
  off; `ctlOverclockResetToDefault` also works elevated only.
- 0-value writes are refused even elevated (freq 0 / volt 0 no-op) �
  cleanup uses elevated resetToDefaults.

### The >252 W cap is a CLIENT-SIDE clamp in the DriverStore runtime

The bundled 2023 IGCL runtime (IntelControlLib.dll v1.0.100, 2022-09-29,
from the Arc OC Tool distribution � vendored at
`src/main/backend/igcl2023/`, THIRD_PARTY_NOTICES.txt) + AppVersion 1.0 +
zero UID + `ctlOverclockWaiverSet` + ELEVATION writes:

| value | DriverStore runtime (zero-UID) | 2023 runtime + elevation |
|---|---|---|
| PL 280/300/315 W | 0x44000004 refused | SUCCESS, **persisted** (verified via separate DriverStore-runtime processes, after the old-runtime process exited) |
| TL 100/110 C | 0x44000005 refused | SUCCESS, persisted |
| TL 125 C | � | clamps to **115 C** (KMD ceiling) |
| freq/volt ranges | identical to the driverstore | identical |

KMD accepts 315 W; the 252 W cap lived only in the v1.2 runtime's client
code. The Acer hint (BiFrost profile XML, 300 W) was right that >252 W is
reachable; the profile-apply path itself is dead (UWP uninstalled) � the
old-runtime + elevation path is OUR unlock.

### Design (M2C-C)

1. **Elevation detection** (`src/main/elevation.js`): koffi -> shell32
   `IsUserAnAdmin`, cached once, no process spawn. Exposed via the
   `app-elevated` IPC channel (`{ elevated, workerApply }`).
2. **Elevate-on-apply**: a non-elevated app delegates every OC action
   (apply, waiver-accept, reset) to an elevated SELF-WORKER
   (`--apply-worker <reqFile> <outFile>`, hidden, never re-elevates, exits
   after writing the result file) via PowerShell `Start-Process -Verb
   RunAs -Wait` (`src/main/elevated-apply.js`). UAC cancel/deny (missing
   result file) -> honest "Apply requires administrator approval." The
   elevated app applies in-process.
3. **Per-control runtime routing** (`src/main/apply-routing.js`):
   PL <= 252 W / TL <= 90 C -> DriverStore runtime; above -> the bundled
   2023 runtime (V1 mW/C setters, `ctl_oc_properties_old_t`, delayed
   verification). Both runtimes can coexist in one process (probe-verified;
   E3 loaded both in one process). Old-runtime failure on a future driver
   degrades honestly per control ("extended power/temp limit requires the
   bundled 2023 IGCL runtime - it failed to load on this driver").
4. **The momentary-lie guard everywhere**: every apply is verified by an
   immediate read-back; on mismatch ONE delayed re-read after ~400 ms � a
   match = the write persisted, still mismatched = honest per-control fail.
5. **Extended capability**: `getCapabilities` reports `extendedRanges:
   true` + PL max 315 (min 105, default 210) / TL max 115 (min 60, default
   90) when the 2023 runtime loads. The UI exposes those maxes; applies
   above 252 W / 90 C require the extended-range confirm dialog (honest
   beyond-standard warning; the BiFrost profile used 300 W).
6. **apply-on-startup**: the HKCU Run key is replaced by a scheduled task
   (`schtasks /create /tn ArcPowerApplyOnBoot /sc onlogon /rl highest /tr
   "<exe>" --apply-profile <id>`) so boot applies run elevated silently;
   ONE UAC at enable time. startup-get reports the mechanism
   (`task` | `run-key` | null).

### Degradation plan

- 2023 runtime fails to load (future driver): extended values fail honestly
  per control; the standard 252 W / 90 C range keeps working through the
  DriverStore runtime; the extended confirm dialog never appears
  (extendedRanges stays off).
- Non-elevated manual `--apply-profile` run (outside the task): applies
  fail honestly per control (the momentary-lie guard reports the revert),
  the defaults-restore attempt fails, the tray balloon reports the failure.
- Elevation probe failure degrades to "not elevated" (the safe direction:
  applies go through the elevated worker, which always works).
- KMD ceilings (315 W / 115 C) are never exceeded � the old-runtime module
  clamps to the verified bounds.
- The real `--headless` smoke path loads the same bundled-2023-runtime probe
  as the product app (`main.js` smoke branch — caps match the app). This is
  safe by construction: a missing/unloadable DLL makes `OldIgcl.isCapable()`
  return `false` (cached), the smoke's caps stay in the standard 252 W / 90 C
  range, and every health line still runs — the smoke never fails on the
  probe alone.
### Deferred live verification (2026-08-05, user away � NO UAC for the hour)

The live worker-mode verification (apply PL 300 W through the real elevated
self-worker and confirm the read-back STICKS via separate DriverStore-runtime
processes, then restore 228 W) and the elevated packaged smoke are DEFERRED
to **M3-B**. Probe: `tools/validate/m2c-c-live-worker.js` (gitignored dev
tooling) � writes the request file, spawns the worker via
`Start-Process -Verb RunAs -Wait`, reads the result file, verifies with
immediate + delayed separate-process reads, then restores PL 228 W.

**CP3a finding already applied to product code:** Start-Process -ArgumentList
cannot pass a space-containing APP path to electron (electron's own CLI
parsing hangs; reproduced live). The product launcher
(`src/main/elevated-apply.js` `buildWorkerLaunch`) therefore passes the app
directory via `-WorkingDirectory` and names it `.` � no spaces in the arg
list; the packaged portable EXE passes no app path at all. The `--apply-worker`
mode itself was verified non-elevated (writes the result file, reads back the
device state, exits 0); only the elevated persistence of an extended value is
pending live confirmation.
