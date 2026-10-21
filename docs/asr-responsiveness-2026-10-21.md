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

## API references

- [DXGI frame metadata](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/ns-dxgi1_2-dxgi_outdupl_frame_info)
- [DXGI presentation flags](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/dxgi-present)
- [SendMessageTimeout](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendmessagetimeoutw)
