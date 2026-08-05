# Level Zero Sysman bindings — M2b (IGS-independent OC experiment)

Date: 2026-08-05. The experiment's motivation: IGCL power/freq/temp setters are
refused/ignored while IGS components run (half-states, docs/igcl-integration.md
§8a) and raw IGCL sets above the 252 W cap return
`0x44000004 ERROR_CORE_OVERCLOCK_POWER_OUTSIDE_RANGE`. The hypothesis tested:
the **Level Zero Sysman** path (`ze_loader.dll` → `zes*`) sits below
IntelControlLib and may not share its arbitration/cap.

## Header provenance (pinned)

- Level Zero **v1.32.0** (released 2026-06-26) — the reference for the struct
  layouts and enums in `src/main/sysman/sysman-bindings.js`:
  - `https://raw.githubusercontent.com/oneapi-src/level-zero/v1.32.0/include/ze_api.h`
  - `https://raw.githubusercontent.com/oneapi-src/level-zero/v1.32.0/include/zes_api.h`
- The DRIVER's `ze_loader.dll` (C:\Windows\System32\ze_loader.dll, ships with
  driver 32.0.101.8861) was built from an OLDER header revision: its
  `ze_result_t` "validation" block (0x78000001..0x78000021) follows the old
  names, while v1.32.0 shifted those meanings. The bindings map BOTH eras and
  prefer the old names on collision (the loader returns old-era codes); the
  probe always prints the raw hex alongside the mapped name.

## Struct layout notes (MSVC x64, v1.32.0)

| C struct | Size | koffi definition notes |
|---|---|---|
| `zes_power_sustained_limit_t` | 12 | `ze_bool_t enabled`@0 (1B), `int32_t power`@4 (**milliwatts**), `int32_t interval`@8 (ms) |
| `zes_power_burst_limit_t` | 8 | `enabled`@0, `int32_t power`@4 |
| `zes_power_peak_limit_t` | 8 | `int32_t powerAC`@0, `int32_t powerDC`@4 (-1 when no battery) |
| `zes_overclock_properties_t` | **32** | stype u32@0, pNext void*@8, domainType u32@16, AvailableControls u32@20, VFProgramType u32@24, NumberOfVFPoints u32@28 |
| `zes_control_property_t` | 40 | 5 × double (Min/Max/Step/Ref/Default) |

> Trap: `zes_overclock_properties_t` is 32 bytes, not 24 — the `void* pNext`
> after the u32 stype pushes the tail out by 8. The size assertion in
> sysman-bindings.js caught the initial 24-byte transcription error at load
> time (this is exactly what the assertions are for).

All sizes are asserted at import time (`EXPECTED_SIZES`), mirroring
`igcl-bindings.js`.

## Enum values (v1.32.0 — NOTE: these are BITMASKS, not ordinals)

`zes_overclock_domain_t`: CARD=1, PACKAGE=2, GPU_ALL=4, GPU_RENDER_COMPUTE=8,
GPU_RENDER=16, GPU_COMPUTE=32, GPU_MEDIA=64, VRAM=128, ADM=256.

`zes_overclock_control_t`: VF=1, FREQ_OFFSET=2, VMAX_OFFSET=4, FREQ=8,
VOLT_LIMIT=16, POWER_SUSTAINED_LIMIT=32, POWER_BURST_LIMIT=64,
POWER_PEAK_LIMIT=128, ICCMAX_LIMIT=256, TEMP_LIMIT=512, ITD_DISABLE=1024,
ACM_DISABLE=2048.

`zes_pending_action_t`: NONE=0, IMMINENT=1, COLD_RESET=2, WARM_RESET=3.

## API surface bound (all via ze_loader.dll exports)

- Core: `zeInit(flags)` (0 = default), `zeDriverGet`, `zeDeviceGet`.
- Sysman init: `zesInit(0)`, `zesDriverGet`, `zesDeviceGet`.
- Overclock: `zesDeviceSetOverclockWaiver`, `zesDeviceGetOverclockDomains`
  (bitmask), `zesDeviceGetOverclockControls` (bitmask per domain),
  `zesDeviceEnumOverclockDomains` (deprecated handle API — still needed: the
  setters take a **domain handle**, not a device handle),
  `zesOverclockGetDomainProperties`, `zesOverclockGetControlCurrentValue`
  (read-back), `zesOverclockSetControlUserValue(handle, control, value,
  &pendingAction)`.
- Power: `zesDeviceEnumPowerDomains`, `zesDeviceGetCardPowerDomain`,
  `zesPowerGetLimits` / `zesPowerSetLimits` (legacy sustained/burst/peak).

There is **no** `zesDeviceGetHandleByDevice` in any LZ release; device
matching is by enumeration order (ze and zes enumerate the same devices in the
same order — the documented contract), with the PCI BDF available via
`zesDevicePciGetProperties` if a cross-check is ever needed.

The legacy `zesPowerGetLimits`/`zesPowerSetLimits` pair is deprecated in
favor of `zesPowerGetLimitsExt` (descriptor-based, v1.0 of the ext) — the
legacy pair is the one to use for the experiment because it is the simplest
and has been stable since LZ 1.0; a loader missing it would also fail the
Ext pair's symbol availability check.

## Units

All power values in the Sysman API are **milliwatts** (int32), interval in
**milliseconds**, freq offset in **MHz**, temp limit in **°C**, voltage in
**volts** — unlike IGCL, the Sysman units are fixed per control, not
capability-driven.

## Probe

`tools/validate/sysman-probe.js` (dev-only, auto-waiver allowed, unconditional
restore in `finally`): init → enumerate → waiver → domain/control bitmasks →
read current power limits → **set sustained 300 W** → read back → restore the
exact prior value (verified) → optional freq offset / temp limit probes
(restored after each). Exit 0 when everything restored, 2 when the device was
left changed. Run with the CURRENT system state (IGS service running) — the
IGS-off variant is a separate later run.

## Probe results (2026-08-05, IGS service running, current system state)

Loader: `C:\Windows\System32\ze_loader.dll` **v1.28.2** (new-era codes —
`0x70010001` = ERROR_NOT_AVAILABLE, `0x78000003` = ERROR_UNSUPPORTED_FEATURE).
Full init chain SUCCESS (zeInit/zeDriverGet/zeDeviceGet/zesInit/zesDriverGet/
zesDeviceGet, 1 device each).

Key lines:

```
[power limits before] sustained={enabled:1, power:228000 mW (228.0 W), interval:20800 ms}
    burst={enabled:1, power:228000} peak={AC:800000, DC:800000}
[overclock domains] ERROR_UNSUPPORTED_FEATURE (0x78000003) mask=0x0
[enum overclock domains] ERROR_UNSUPPORTED_FEATURE (0x78000003) count=0
[waiver] zesDeviceSetOverclockWaiver -> ERROR_UNSUPPORTED_FEATURE (0x78000003)
[SET 300 W] zesPowerSetLimits -> ERROR_NOT_AVAILABLE (0x70010001)
[read-back 300 W] sustained={enabled:1, power:228000 mW (228.0 W) ...}
[verdict-300w] ACCEPTED_AND_STICKS=false
[restore] power limits -> ERROR_NOT_AVAILABLE (0x70010001)   (same-value 228 W set ALSO refused)
[final] sustained=228000 mW (was 228000) burst=228000 peakAC=800000 powerRestored=YES
```

Verdict:

1. **Sysman does NOT bypass the arbitration.** The 300 W set is refused with
   `ERROR_NOT_AVAILABLE`, whose header doc is exact: *"The device is in use,
   meaning that the GPU is under Overclocking, applying power limits under
   overclocking is not supported."* The card was in an OC'd state (228 W from
   the BiFrost "YoYo" profile, IGS running) — the KMD refuses power-limit
   writes at the Sysman level in that state, same as IGCL. The 252 W cap
   question is moot in this state: ALL power-limit writes are refused, not
   just >252 W.
2. **The Sysman overclock domain API is unimplemented on this driver**
   (UNSUPPORTED_FEATURE on domains + waiver) — no Sysman freq/temp/VF OC
   controls exist on the A770 with driver 32.0.101.8861.
3. **Sysman read path works and agrees with IGCL** (228 W sustained, 800 W
   peak AC/DC, 20.8 s interval).
4. **Safety implication (would-be trap):** a same-value restore set was also
   refused (NOT_AVAILABLE) while OC is active — had the 300 W set succeeded,
   restoring via Sysman would have failed and stranded the device at 300 W.
   This alone disqualifies Sysman as a product path even if a set ever stuck.

Recommendation: **keep IGCL** as the apply path; do not swap to Sysman. The
power-limit unlock (>252 W) is not reachable from userspace on this card
(KMD-level arbitration); the plan's fallback (retry-with-backoff + "driver
busy" hint, half-state warning) is the right mitigation. The IGS-off variant
of this probe (host's job) will confirm whether the NOT_AVAILABLE clears with
IGS fully off — expected: writes then succeed through Sysman like they do
through IGCL, still capped at 252 W.
