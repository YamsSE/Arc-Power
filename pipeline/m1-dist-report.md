# M1 Distribution Build Report

Date: 2026-08-05 01:14 local

Artifact: `dist\Arc-Power-0.1.0.exe` (83.7 MB, portable, x64, electron-builder 26.15.3, Electron 37.10.3)

Checks (per AGENTS.md step 6):

1. `npm test` — green at implementer checkpoint (112/112), dev-tree smoke green.
2. `npm run dist` — produced `dist\Arc-Power-0.1.0.exe`; default Electron icon (no icon asset yet).
3. Packaged EXE headless smoke — **pass, exit 0**: `dist\Arc-Power-0.1.0.exe --headless`
   (koffi native module survives asar + portable extraction; verified against real A770,
   driver 32.0.101.8861).
4. Cross-check of the unpacked packaged app (`dist\win-unpacked\Arc Power.exe --headless`)
   also exit 0: init/discovery/caps/state/no-op/verify/telemetry/reset/health all green;
   IGCL loaded via koffi from the packaged tree; no value changed on the device.

Notes:

- stdout of the portable EXE does not propagate to a redirected file (NSIS wrapper spawns a
  child process) — the exit code is the authoritative signal; log verification done via the
  win-unpacked tree.
- `electron-winstaller` install script not approved (allowScripts) — unused, portable target
  only; no impact.
- asarUnpack set for `node_modules/koffi/**`; `dist/` gitignored.
- Rule "always build dist EXE after every milestone" added to AGENTS.md step 6.
