# Arc Image Sharpening and ASR validation (1.2.5)

Arc Image Sharpening runs the bundled controlled ReShade shader in a game
launched from its Arc Power profile. ASR independently enlarges the game using
the existing DWM thumbnail helper. Either switch can be enabled alone, and both
can be enabled together. The desktop capture sharpening overlay remains disabled.

## Verified on 26 October 2026

- Intel Arc B580, Expedition 33, 1280×720 Windowed, XeSS frame generation active.
- Six interleaved Off / sharpening 100% / Off / ASR / ASR + sharpening 100% / Off
  intervals; every interval retained the exact game PID and creation time for
  all 74 foreground samples. The shader acknowledged render-applied revisions.
- The user reported both sharpening and the simultaneous path felt smooth.
- Application-frame median/p99 milliseconds: Off-before 13.10/16.10,
  sharpening 13.92/16.43, Off-middle 13.21/15.85, ASR 13.65/21.37,
  ASR + sharpening 13.53/19.76, Off-after 13.20/17.19. Frame-generated presents
  were analyzed separately. This short trace does not measure physical input
  latency or establish zero performance cost.
- Independent fixed-menu Off/100%/Off captures: 83.89% common temporally stable
  pixels, with 70,510 of those pixels changing beyond one channel level.
  The user separately confirmed a visible sharpening change. Animated pixels
  were excluded from that comparison.
- Normal-user and elevated production-service fixture checks passed global,
  per-game and Off updates. Elevated Arc Power relays game creation to the
  same user's normal-integrity Explorer session.
- A long-path regression reproduced the initial E33 source-read failure above
  MAX_PATH. The rebuilt preprocessor uses extended Windows paths. The owned
  DX11 fixture subsequently compiled and applied the shader from a source path
  longer than 260 characters and produced different Off/On GPU images.
- Focused JS/native control tests, typecheck, main Graphics UI and Advanced
  Overlay UI checks passed. UI checks include independent simultaneous status
  and failure feedback.

## Limits

The managed launcher currently supports x64 games. This validation covers an
owned DX11 fixture and Expedition 33's DX12 path; it does not establish Vulkan,
DX9, DX10, OpenGL, every game's anti-cheat compatibility, or other display modes.
Vulkan requires a layer path rather than merely loading the DLL and remains
unverified here. Steam/Epic launches that have no managed runtime loaded need
an Arc Power profile launch first. No game-directory integration is performed.

Diagnostic traces and images remain local under `.codex/task-artifacts`.
Runtime source provenance, pinned upstream revision, patch and dependency
licenses are in `src/main/sharpening-runtime`.
