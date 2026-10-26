# ASR and screen sharpening responsiveness — 21 October 2026

## Changes

ASR's mouse forwarding previously called `SendMessageTimeout` from the same thread that captured and presented frames. A game taking time to handle an input message could hold that thread for up to 50 ms per event. The same thread used a 100 ms capture timeout and vertical-refresh-synchronized presentation.

Mouse delivery now uses a separate ordered dispatcher. Consecutive mouse moves can be coalesced, while button transitions retain their order. Overlay teardown clears pending input for that target and releases buttons tracked by the dispatcher. It retains the existing ordinary Windows mouse-message mechanism; it does not introduce raw-input or DirectInput support.

Both ASR and Arc Image Sharpening acquire available desktop frames without waiting and service window messages during short idle waits. Presentation does not wait for vertical refresh or an occupied presentation queue. A busy presentation is retried without repeating the scaling/sharpening draws. The helper requests a maximum frame latency of one from its own DXGI device, and skips pointer-only desktop updates once the current source has been processed. This changes presentation scheduling; it does not guarantee a particular game FPS, latency, or absence of tearing.

The helper explicitly invalidates its captured crop and scaling buffers when the same foreground window's client geometry changes. The viewport and mouse transform update in the running loop. Current display bounds and rotation are also checked when deciding whether the capture output can be reused. Geometry refresh remains pending across capture timeouts, so an idle frame cannot discard a resize notification.

ASR's Apply button displays `Applying…` during the request and `Applied` after a successful preference save. Changing the selection or resetting clears that confirmation. Success and error toasts accompany the result; saved-but-idle ASR reports that it is waiting for an eligible game rather than claiming active scaling. Runtime recovery clears obsolete warning text.

## Focused verification

- The native helper builds with the existing optimized C++ build script; its executable hash is pinned in `sharpening-screen.js`.
- The Electron mock UI check holds an ASR save open to verify disabled controls and the busy label, then exercises success, waiting status, failure, retry, reset, and warning recovery through the actual IPC/renderer path.
- `test/native-screen-runtime-v2-probe.cpp` includes the production runtime and invokes its normal loop with only the stdin reader disabled. On the Intel Arc 1920×1080 output, it checks that the same foreground test HWND remains active while resized and repositioned, and that forwarded coordinates change from the original client center to the resized client center. It also exercises a slow target input handler and button release after capture loss. No user display mode is changed.

Build the native probe with `test/build-screen-runtime-v2-probe.ps1`, then run `.codex/task-artifacts/asr-runtime-v2/native-screen-runtime-v2-probe.exe` in an interactive desktop session. It creates temporary test windows and restores the previous foreground window on exit. It is not an automatic headless test.

These checks do not reproduce a particular game's frame-time distribution. A matched game run with ASR/sharpening off and on is still required to measure the remaining capture, spatial-filter, and desktop-composition cost. The controlled resize/input checks do not establish universal game, anti-cheat, cursor, or raw-input compatibility.

## October 24 game-test status

The changes above did not establish acceptable game responsiveness. The legacy
capture-overlay production path remains disabled. A separate WGC prototype
passed controlled cursor alignment checks, but Expedition 33 still felt uneven
to the user with both baseline and wait-before-render scheduling. The latter
was reported as potentially worse and is not accepted as a fix.

An isolated zero-capture-interval trial on October 24 also remained subjectively
bad. Its log verifies `MinUpdateInterval` changed from 160000 (16 ms) to zero
before capture, with wait-before-render disabled. Both the Off-before interval
and all 109 foreground polls during ASR passed; the Off-after interval lost
foreground and is excluded. The helper completed its 12-second deadline with
812 successful Present submissions and no retries. The overall run is partial,
but the valid ASR interval remains usable evidence.

Within the trimmed 7.98-second ASR interval, game telemetry contains 517
Application frames and 1457 XeSS-FG rows. These game records and the helper's
roughly 68 submissions per second measure different stages; neither establishes
the helper's actual displayed cadence. The current capture selected only the
game PID. WGC source timestamps remain irregular (raw gap median approximately
16.67 ms and p95 27.78 ms). Negative derived ages prevent using source-to-Present
subtraction as a latency measurement. The next diagnostic must distinguish
source cadence from helper presentation using separate process telemetry.

The retained run is `20261024T192950Z-e33-asr-ef167008` under the local
`.codex/task-artifacts/asr-wgc-proof/e33-comparison/runs/` folder. The user-visible
smoothness problem remains unresolved; these experiments are not distributable
performance fixes.

## Controlled presentation measurements on October 24

The first controlled-window run completed but achieved only about 65.6 source
submissions per second at a requested 120. Its standard waitable timer was a
test-fixture fault, so it cannot establish a 120 FPS condition. An independent
nonvisible timer probe reproduced approximately 15.64 ms standard waits versus
8.64 ms high-resolution waits for an 8.33 ms request. The fixture now requires
a per-handle high-resolution timer without a global timer-resolution request.

The subsequent paired run, `cadence-20261024T201133Z-fdeb34eefc5e4e6f8f021c3d79ce7229`,
completed with 7,201 source submissions in 60.0045 seconds, no skipped targets,
and approximately 120 source submissions per second in both helper phases.
Foreground, geometry, readback and owned-process cleanup checks passed.

The default two-pass Lanczos path and a diagnostic bilinear-only path used the
same capture, crop, host window, presentation policy and output viewport.
In their trimmed intervals, the helper's real DXGI swap chain reported:

| Metric | Lanczos | Bilinear diagnostic |
| --- | ---: | ---: |
| Mean GPU time | 1.918 ms | 0.696 ms |
| Positive DisplayedTime samples / DXGI rows | 738 / 959 | 776 / 958 |
| DisplayedTime p95 | 22.210 ms | 16.669 ms |
| DisplayedTime p99 | 33.323 ms | 27.779 ms |
| Maximum DisplayedTime | 50.004 ms | 33.338 ms |

These are process-level ETW timings, not physical input-to-photon measurements.
The analyzer keeps each owned PID and PresentRuntime/SwapChainAddress group
separate; helper `Other/0x0` records are not merged with the real DXGI chain.
This single fixed-order run supports a contribution from resizing cost, but
does not isolate time/order effects. Both paths retain longer displayed-frame
holds, and the user could not confidently distinguish their smoothness.
The bilinear path is a diagnostic, not an accepted replacement or performance
fix. Presentation-stage investigation remains open.

## Thumbnail feasibility on October 25

The disabled `NOREDIRECTIONBITMAP` host was rejected on this system. During
a guarded ten-second phase the source stayed foreground and enabled, but
received no covered mouse-button pairs. The user confirmed that clicks worked
before the covering bar appeared and stopped while it was present.

A separate layered DWM-thumbnail host preserved all three paired target clicks
during its complete ten-second phase. Because the user could not confirm the
displayed image, a separate automatic observer checked three owned-window
pixels before registration, during display, after a source repaint, and after
unregistration. Run `pixel-20261025T024429Z-97cf55f166ce4a548322da053fce4205`
passed: the shifted marker appeared red, changed to green with the source
repaint, then disappeared after unregistration. Foreground stayed unchanged;
the owned process exited normally without watchdog termination.

These results establish only rendering, live updates and input feasibility in
the tested window topology. They do not establish enlarged output cadence,
game compatibility or improved responsiveness.

The subsequent controlled cadence run,
`thumbnail-cadence-20261025T031240Z-051a17840ca04308aab25d40ace731eb`,
completed with 5,400 successful source submissions over 45.0031 seconds. The
source stayed approximately 120 submissions per second in each matched phase.
The DDA observer read only a single numeric frame-ID row, with no screenshot
files, invalid IDs, capture errors, record overflow or accumulated-frame gaps.
Both owned processes exited normally, with successful stream draining.

| Matched interval | Observed ID changes | Interval | Maximum sample gap |
| --- | ---: | ---: | ---: |
| Normal window before | 360 | 3.0104 s | 12.918 ms |
| Thumbnail active | 1,080 | 9.0027 s | 14.133 ms |
| Normal window after | 360 | 3.0092 s | 15.110 ms |

Every forward ID advance in the trimmed intervals was one. Independent review
confirmed the raw CSV and analysis agree. This supports near-source-rate
synthetic image updates through the thumbnail in this run. These are lower-bound
pixel observations, not scanout or input-latency measurements. The run did not
persist monitor/destination viewport dimensions, so it cannot independently
quantify the enlargement ratio. Game compatibility, mouse mapping at enlarged
coordinates and responsiveness in Expedition 33 remain to be validated before
production integration.

## Expedition 33 thumbnail trial on October 25

After the Windows reinstall and restoration of the C++ build tools, run
`20261025T200240Z-thumbnail-timing-94dc65502a8142eb8d57cfb830214252`
captured a complete four-second normal-window baseline and a complete
12.006396-second thumbnail phase. The recorded game client was 1280×720;
the Intel output, host and fitted destination were 1920×1080. All 770
foreground checks and 47 output checks in the active phase passed, with
successful DWM registration, update, flush and unregistration.

The user reported the result felt "MUCH MUCH Smoother" and confirmed normal
mouse-look and clicks during the enlarged section. This supports this exact
game/setup and direct-input topology; it does not establish universal mouse
compatibility.

Matched 500 ms edge trims, exact game PID and the same DXGI swap chain gave:

| Application telemetry | Before | Thumbnail active |
| --- | ---: | ---: |
| Records | 157 | 579 |
| Mean FrameTime | 19.1334 ms | 19.0064 ms |
| FrameTime p95 | 21.6155 ms | 21.6699 ms |
| Mean GPUTime | 9.8827 ms | 9.8993 ms |

The active interval separately contained 1,733 Intel XeSS-FG records; they
were not merged with Application records for these statistics. These short,
ordered intervals show approximately unchanged application pacing and GPU
time. Present mode changed from Hardware Composed: Independent Flip to
Composed: Flip. Process telemetry does not identify the cause of the perceived
improvement or measure physical input latency or thumbnail scanout.

The final normal-window phase lost foreground before its deadline and is
excluded. The overall run therefore remains partial; the completed baseline
and active phase remain valid. Native cleanup reported zero errors, the
observer exited without being killed, streams drained, and the unique ETW
session stopped successfully. Independent review confirmed the raw data.

Integration now replaces the ASR capture/presentation branch with this
thumbnail path, preserving the game catalog and foreground gates. Arc Power
activation, pause, shutdown and broader input compatibility still require
validation before packaging.

## API references

- [DXGI frame metadata](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/ns-dxgi1_2-dxgi_outdupl_frame_info)
- [DXGI presentation flags](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/dxgi-present)
- [SendMessageTimeout](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendmessagetimeoutw)
