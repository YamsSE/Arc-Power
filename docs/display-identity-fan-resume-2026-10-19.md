# Display and Graphics identity repair and Arc Hibernation Fix

## Graphics apply failure

The reported `graphics:apply` failure named the saved key
`pci:0x8086:0x56a1@0000:03:00.0`. Graphics reads and writes now carry the
renderer-selected durable GPU key, resolve a unique current inventory target,
and forward its canonical key and physical proof to the elevated worker. The
worker resolves its own numeric ID. This also covers a boot-time ID remapping
that has not yet been persisted, or re-enumeration after the page was opened.
Unknown, unrelated, or ambiguous identities are refused before any hardware
call. Missing or unreadable saved identity cannot authorize an ordinal-only
production driver request. The global RTSS-only FPS cap remains independent
of GPU identity.

Regression tests exercise the exact reported 56a1 PCI key, PCI-to-PNP identity
enrichment, separate parent and worker numeric IDs, and refusal cases with zero
writes. This establishes the routing fix; the affected 56a1 card was not live
tested. The B580 live display evidence below is separate.

## Display apply failure

The reported `stale display target: the selected graphics adapter changed` message
was raised by the parent `display:apply` handler before an IGCL write. A read-only
test reproduced it on the B580 on 19 October 2026:

- Initial adapter key: `pci:0x8086:0xe20b@0000:03:00.0`.
- After deferred Windows system information arrived: the same session adapter
  used its Windows PNP key for `VEN_8086&DEV_E20B&SUBSYS_60211849`.
- The original PCI key remained a unique alias of that physical adapter.
- The old strict string comparison would reject the request.

The handler now reconciles only a unique inventory alias, checks the physical
target again inside the display transaction, and forwards the current canonical
adapter key and corresponding display namespace. An unrelated, ambiguous,
read-only, replaced, or mismatched display target is refused. The elevated worker
continues to resolve its own local adapter ID from physical proof.

### Live B580 evidence

The real parent IPC handler was exercised in an administrator process with the
original pre-enrichment PCI key. Centered, Stretched, Aspect Ratio Centered Max,
and Maintain Display Scaling requests all succeeded. Native IGCL reads confirmed
the expected preferred flags 2, 4, 8, and 8 respectively. At native 1920 x 1080,
active Identity scaling remained 1, as established in the previous scaling audit.
The original native selection was restored and verified. An independent watchdog
was armed for rollback during the test.

Ignored local evidence is in
`.codex/task-artifacts/display-identity-fan-resume/identity-baseline.json` and
`display-ipc-live.json`. These files contain local hardware identities and are
not distribution payloads.

## Arc Hibernation Fix

The Fan tab includes an opt-in switch, **Reapply fan settings after sleep**.
Its card is named **Arc Hibernation Fix**. The user confirmed the feature works
on their B580 after trying the previous build.
It is off by default and scoped to the selected physical GPU. Arc Power must
remain running, including in the tray. This feature is for returning from sleep
or hibernation; it does not create a boot task or enable Windows startup.

Enabling captures confirmed current fan settings. Subsequent successful fan
applies update that selection. Unapplied curve edits are not captured. Automatic
mode restores driver stock control; Curve mode restores the selected custom
table, including the Intel Curve preset. Existing Fixed mode is preserved too.
Only fan controls are submitted, through the ordinary validated apply route.

Fan restoration uses Electron's main-process `powerMonitor` resume notification.
The Windows notification beneath it is `PBT_APMRESUMEAUTOMATIC`, documented for
both sleep and hibernation. A short delay and bounded readiness retries allow the
driver to become available. Identity is resolved afresh; numeric adapter IDs
are not persisted as authority. Pending work is canceled when the feature is
disabled, another fan selection is applied, the system suspends again, or Arc
Power shuts down or prepares maintenance. Automatic restore does not open a UAC
prompt. A normal elevated Portable or Installer session can restore in process.

The saved selection is a separate durable `FanResume.json` sidecar, so unrelated
profile or settings saves cannot erase it. A failed or incomplete fan apply
invalidates its old restore selection rather than silently replaying it later.
Restore progress and errors update the mounted Fan card. Ambiguous saved aliases
block all writes for that physical GPU; switching the feature off clears those
saved candidates without writing hardware.

### Live B580 fan evidence

In a verified administrator process, the production controller and ordinary
`apply-settings` handler restored both cases using simulated resume callbacks:

1. Saved stock Auto mode, deliberately applied a custom curve outside the
   controller, then restored and verified Auto mode.
2. Successfully applied and saved a custom five-point curve, deliberately
   returned the driver to Auto outside the controller, then restored and
   verified the exact custom table.
3. Disabled the feature and verified that a subsequent callback made no apply.

All dispatched payloads contained only fan fields. Existing persisted waiver
consent was read; it was not fabricated or changed. The final cleanup restored
and verified the original Auto fan mode. An independent rollback watchdog was
armed. The test used an isolated sidecar, leaving the user's opt-in preference
at its default. Local evidence is `fan-resume-live.json` alongside the display
artifacts listed above.

### Sources

- [Electron powerMonitor events](https://www.electronjs.org/docs/latest/api/power-monitor)
- [Windows PBT_APMRESUMEAUTOMATIC](https://learn.microsoft.com/en-us/windows/win32/power/pbt-apmresumeautomatic)
- [Electron 37.10.3 power monitor source](https://github.com/electron/electron/blob/v37.10.3/shell/browser/api/electron_api_power_monitor.cc)
- [Bundled Chromium 138 Windows power monitor source](https://github.com/chromium/chromium/blob/138.0.7204.251/base/power_monitor/power_monitor_device_source_win.cc)

### Verification boundary

Display identity, scaling writes, and fan restoration were exercised on the real
B580. Resume notifications were simulated without putting the user's computer
to sleep. A complete physical sleep and hibernation cycle, and a separate
Windows 10 machine, remain manual validation steps. This does not prove that
every driver retains valid IGCL handles or becomes ready within the bounded
retry window after a real resume. Focused automated checks, independent review,
and packaging evidence are recorded with the final build report.

The earlier a425980 source pass completed 213 focused Node tests, TypeScript checking,
the renderer build, and four real Electron/Chromium MockBackend checks (Fan
resume, display scaling, managed display color, and sharpening). The Fan check
also injected a restore refusal and verified visible failure feedback on the
already open card. Independent Luna xhigh review reported no remaining material
blockers. The full repository suite and an actual Installer installation were
not run.

After the card renames and additional Graphics request-identity repair, the
combined focused batch passed 276 Node tests. TypeScript checking and the
renderer build passed again. All four current Electron UI checks passed,
including the Arc Hibernation Fix and global/per-game Arc Image Sharpening
labels; the retired sharpening runner's compatibility entry point also passed
the current sharpening checks. Independent Luna xhigh review accepted these
final changes with no material blockers.
