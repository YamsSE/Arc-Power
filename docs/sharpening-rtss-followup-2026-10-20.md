# Sharpening pacing and RTSS follow-up

## Implemented changes

- RTSS profile enumeration always supplies a writable buffer, starting at 4096 bytes and growing up to 1 MiB. It no longer makes a null-pointer size query. The installed RTSS DLL crashed the isolated profile worker with `0xC0000005` once an application profile existed; the same operation succeeds with the bounded buffer. Profile enumeration is also used by limiter cleanup, so this affects more than sharpening setup.
- Arc Sleep probes RTSS availability independently of a protected IGCL recovery journal. The UI distinguishes **RTSS · Paused** from **Unavailable**, shows the recovery reason, and does not instruct users to enable Load Adaptive when it is already enabled.
- Explicit Base FPS Apply can re-arm an external-change journal on its verified original provider. Apply and rollback stay on that provider. Automatic polling does not clear the external-change protection. A later preferred-provider transition uses normal recovery. Explicit Off on one provider preserves an outside-owned cap on another provider; the effective-cap tile reports that actual cap.
- Before launching sharpening, Arc Power ensures a dedicated `ArcPower.ScreenSharpen.exe` RTSS profile has `FramerateLimit=0`. This prevents a global RTSS cap from pacing the helper independently of a game's profile. The check is repeated at most once per five seconds while sharpening runs, to handle RTSS starting later. It never saves the global profile or changes RTSS limiter flags. New helper profiles inherit the other global properties, remain installed intentionally, and affect only this helper basename. Existing helper profiles with a nonzero or unreadable cap are preserved and reported as a conflict.
- Sharpening output uses a two-buffer DirectComposition `FLIP_SEQUENTIAL` swap chain with a waitable latency object and a maximum frame latency of one. The previous output path used a legacy blit swap chain. Desktop Duplication capture, the shader's RGB calculation, game recognition, monitor routing, and per-game overrides are retained. The shader explicitly outputs opaque alpha for the premultiplied composition surface.
- A ready presentation slot is retained through capture timeouts and pointer-only frames, then consumed by a successful Present. Teardown detaches composition content and closes the waitable handle. A window closing or losing focus during initialization is no longer reported as evidence that its monitor lacks an Intel output.
- Advanced Overlay → Global Graphics includes **Arc Image Sharpening**, using the same global setting as the Graphics page. Strength is an integer 0–100% slider. Apply/Saved/error feedback and runtime errors are visible; saving a configuration is not treated as proof that a foreground game is actively sharpened.

## Live evidence

Host: Intel Arc B580, driver `32.0.101.9150`, one 1920×1080 output at 180 Hz, RTSS `7.3.5.28314`. These results do not reproduce the original reporter's driver 9030 environment.

### Independent RTSS cap

Temporary diagnostic profiles isolated the helper's cap while the animated fixture remained near 140 FPS. Both conditions used application detection level 1:

| Helper cap | Helper successful presents over approximately 12.6 s | Mean CPU time inside Present |
| --- | ---: | ---: |
| 60 FPS | 754 | 11.758 ms |
| Unlimited | 2257 | 0.538 ms |

The global RTSS profile remained unchanged and all temporary diagnostic profiles were removed. This establishes a separate RTSS pacing problem; it does not explain the entire reported symptom. The user subsequently confirmed that sharpening still felt bad after changing global RTSS to unlimited.

The production profile RPC then passed two consecutive compatibility checks with an existing helper profile. The global limiter state remained `{ limit: 0, denominator: 1, limiterEnabled: true }`, and the global profile file's SHA-256 remained unchanged. The bounded native enumeration returned 27 bytes containing `ArcPower.ScreenSharpen.exe`.

### Capture freshness

A second fixture encoded each source-frame number into pixels. Three diagnostic helpers read a tiny raw-source strip through a three-slot staging ring using nonblocking Map; none of that readback code is shipped. Each 14-second run retained the foreground for 100% of its rendered frames.

| Capture/output diagnostic | Fixture submission FPS | Distinct captured source FPS | Repeated source samples |
| --- | ---: | ---: | ---: |
| 1.2.4 baseline DDA + legacy output | 139.855 | 139.904 | 22.20% |
| DDA + DirectComposition output | 139.865 | 140.003 | 22.21% |
| Experimental window capture + DirectComposition | 139.867 | 140.046 | 0% |

All helpers and fixtures exited successfully. There were no nonbinary tags or busy nonblocking maps. The diagnostic label `legacy-1.2.3` is incorrect: that helper was generated from the local **1.2.4 baseline**. The DDA repeats are consistent with approximately 180 acquisitions per second from a source changing at 140 FPS. This test does not support a materially stale raw-capture stream in that scenario.

Window capture remains an unshipped experiment. Its initial Windows session was limited to roughly 60 updates per second; setting the supported `MinUpdateInterval` property to zero removed that throttle. Its fresh-source rate did not establish a latency improvement over DDA, and it was deliberately limited to monitor-sized borderless windows.

### Presentation and UI

The on-screen functional matrix covered sharpening Off, baseline output, instrumented new output, and the production new output at 60/140 FPS in windowed and borderless fixtures. One instrumented windowed run lost sustained activity and is not accepted as pacing evidence. A user-coordinated repeat produced about 1896 successful helper presents in windowed mode and 1899 in borderless mode over approximately 10.6 seconds of active capture. Diagnostic frame statistics advanced; the largest difference between latest submitted and reported displayed present IDs was two. That difference is not a direct measurement of queue depth or physical latency.

Separate Chromium UI checks cover paused/unavailable RTSS labels and the enabled Load Adaptive guidance. The Advanced Overlay checks cover saved percentage, 0/100 endpoints, shared global API writes, success and runtime-conflict feedback, rejected saves retaining a draft, reopening, and detached-card asynchronous results.

## Acceptance limits

The fixture is lightweight and does not represent a demanding game at high GPU load. Captured source FPS, helper submission cadence, and CPU time in Present do not measure physical input-to-photon latency. Sustained PresentMon display rows were unavailable in several overlay conditions; that is an unresolved tracing limitation, not evidence of low displayed latency. The new presentation path still needs the user's same-game sharpening On/Off comparison before the reported bad feel can be called resolved.

The existing RTSS test `RTSS recovery can retain the enabled Graphics cap for a later owned cleanup` previously called explicit global Off while expecting restoration of an older 40/3 cap. That obsolete assertion failed on the unchanged baseline too. The test now exercises the ownership-specific restore API and verifies the retained underlay. Production explicit Off semantics were preserved.

## References

- [Microsoft: composition swap-chain requirements](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgifactory2-createswapchainforcomposition)
- [Microsoft: reducing latency with a waitable swap chain](https://learn.microsoft.com/en-us/windows/uwp/gaming/reduce-latency-with-dxgi-1-3-swap-chains)
- [Microsoft: frame-statistics limits](https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgiswapchain-getframestatistics)
- [Microsoft: graphics-capture update interval](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.minupdateinterval)
- Installed RTSS SDK: `SDK/Samples/SharedMemory/RTSSSharedMemorySample/RTSSProfileInterface.h` and `.cpp`.
