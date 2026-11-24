# ReBAR detection diagnosis

## Evidence on the primary test machine

Read-only `scripts/rebar-probe-igcl.mjs` against the installed
`IntelControlLib.dll` returns:

- `ctlPciGetProperties` is exported
- `Size = 64` succeeds
- bytes 56/57 = `01 01` → `resizableBarSupported: true`,
  `resizableBarEnabled: true`
- GPU-Z and Intel Graphics Software both show ReBAR enabled, BAR 16384 MB

So the driver source is correct on this host and the native path now reads it
via `ctlPciGetProperties` (offsets 56/57, sentinel initialisation, size 64).

## Why another B580 can still be gray

The primary source can be unavailable on a different driver:

1. `ctlPciGetProperties` may not be exported by that ControlLib build.
2. The call can fail with a non-success status.
3. The driver can leave the sentinel flags unwritten.

The previous code silently degraded to null in all three cases, and the WMI
fallback was case-sensitive (`VEN_…` vs `ven_…`) and required a large WMI BAR
range, which this host does not expose either.

## Changes in this pass

- WMI allocation matching is now case-insensitive and accepts both PNP and
  VEN+DEV forms.
- `sysinfo.videoControllers[].rebarSource` reports `igcl`, `wmi`, or null so the
  effective source is visible.
- Native logging on failure:
  - `[rebar] ctlPciGetProperties is not exported by this driver`
  - `[rebar] ctlPciGetProperties failed with status 0x…`
  - `[rebar] driver did not write BAR flags …`

## What is needed from the other machine

Ask the other B580 owner to run the new build from a console (or capture the
app's stderr log) and report any `[rebar] …` lines, plus their Intel Graphics
Software driver version and whether its ReBAR badge is green. If there is no
`[rebar]` line and the badge is still gray, send the `rebarSource` value from
`sysinfo` so we can tell whether the fallback path ran.

No further guessing: the next fix depends on which of the three failure modes
is present on that host.
