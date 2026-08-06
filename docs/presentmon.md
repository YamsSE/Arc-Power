# PresentMon integration — M2b/M3-C-L (FPS / frame-time)

Date: 2026-08-05 (M2b), updated 2026-08-06 (M3-C-L).
Client: `src/main/presentmon/presentmon-client.js`.

## API version and provenance

The client uses the **PresentMon v2.5.1 session API** (PresentMonAPI2.dll
2.5.1.0, x64):

- Release: https://github.com/GameTechDev/PresentMon/releases/tag/v2.5.1
  (note: PresentMon moved from microsoft/PresentMon to **GameTechDev**)
- Header: `PresentMonAPI2/include/PresentMonAPI.h` from the v2.5.1 tag
  (`https://raw.githubusercontent.com/GameTechDev/PresentMon/v2.5.1/IntelPresentMon/PresentMonAPI2/PresentMonAPI.h`)
  — the v2.5.1 MSI ships the same header at `Intel\PresentMon\SDK\PresentMonAPI.h`.
- Binaries (M3-C-L: now TRACKED and SHIPPED in the EXE, same-version
  guarantee): extracted from `PresentMon-v2.5.1.msi` →
  `Intel\PresentMonSharedService\{PresentMonAPI2.dll, PresentMonService.exe}`,
  vendored at `tools/presentmon/`. The "shared service" implementation
  lives IN PresentMonAPI2.dll (the service exe hosts it) — there is NO
  `PresentMonSharedService.dll` in v2.5.1. `PresentMonAPI2Loader.dll` (a
  registry-based loader) is NOT used — we load the DLL directly via koffi.

> **API note (deviation from the M2b prompt):** the prompt's
> `PMInitialize` / `PMRegisterForFrameEvents` / `PMGetLatestFrameEvent` /
> `PM_FRAME_EVENT_STRUCT` surface is the **v1.x-era PresentMonAPI2**, which
> was **removed in PresentMon v2.0**. No current release ships it. The v2.5.1
> API is session-based: `pmOpenSession` → `pmStartTrackingProcess(pid)` →
> `pmRegisterFrameQuery` → `pmConsumeFrames` (raw blob per frame) →
> `pmCloseSession`. The client keeps the renderer-facing interface from the
> prompt (`start(deviceId, pid)`, `poll() → sample|null`, `stop()`) and maps
> the frame-event blob → `{ fps, frameTimeMs, gpuBusy, presentedFps }`.

## Struct layout notes (MSVC x64, v2.5.1 header)

| C struct | Size | Notes |
|---|---|---|
| `pm_query_element_t` | 32 | `PM_METRIC metric`@0 (int32), `PM_STAT stat`@4, `uint32_t deviceId`@8, `uint32_t arrayIndex`@12, `uint64_t dataOffset`@16, `uint64_t dataSize`@24 |
| `pm_version_t` | 40 | 3×uint16@0, `char tag[22]`@6, `char hash[8]`@28, `char config[4]`@36 |

`PM_STATUS` enum (int32): SUCCESS=0, FAILURE=1, BAD_ARGUMENT=2, BAD_HANDLE=3,
SERVICE_ERROR=4, INVALID_ETL_FILE=5, INVALID_PID=6, ALREADY_TRACKING_PROCESS=7,
UNABLE_TO_CREATE_NSM=8, INVALID_ADAPTER_ID=9, OUT_OF_RANGE=10,
INSUFFICIENT_BUFFER=11, PIPE_ERROR=12, SESSION_NOT_OPEN=13,
MIDDLEWARE_MISSING_PATH=14, NONEXISTENT_FILE_PATH=15,
MIDDLEWARE_INVALID_SIGNATURE=16, MIDDLEWARE_MISSING_ENDPOINT=17,
MIDDLEWARE_VERSION_LOW=18, MIDDLEWARE_VERSION_HIGH=19,
MIDDLEWARE_SERVICE_MISMATCH=20, QUERY_MALFORMED=21, MODE_MISMATCH=22,
FEATURE_DISABLED=23.

## Frame-event blob layout (the v2.5.1 frame query contract)

Frame queries consume **raw blobs**, not a struct:

1. The client passes a `pm_query_element_t[]` (metric/stat/deviceId/
   arrayIndex; offsets zeroed) to `pmRegisterFrameQuery`.
2. The service validates the metrics and **writes each element's
   `dataOffset`/`dataSize` back into the caller's array** (offset into the
   per-frame blob, size of the value) and returns the blob size (padded to
   a 16-byte multiple so array blobs stay aligned).
3. `pmConsumeFrames(handle, pid, blob, &n)` writes up to `n` consecutive
   frames of `blobSize` bytes each.
4. Each element's value sits at `blob + frameIndex*blobSize + dataOffset`.

Metrics used (enum values from the v2.5.1 header):

| Metric | id | Type | Size | Notes |
|---|---|---|---|---|
| DISPLAYED_FPS | 12 | double | 8 | 1/msBetweenDisplayChange × 1000 |
| PRESENTED_FPS | 13 | double | 8 | 1/msBetweenPresents × 1000 |
| GPU_BUSY | 15 | double | 8 | ms of GPU busy per frame |
| DISPLAYED_FRAME_TIME | 137 | double | 8 | ms between display changes |
| PRESENTED_FRAME_TIME | 139 | double | 8 | ms between presents |

Device IDs: fps/frame-time metrics are **universal** (`deviceId = 0`,
`kUniversalDeviceId`); CPU/system telemetry = 65536 (`kSystemDeviceId`).
Unavailable values are NaN in the blob — the decoder maps NaN → null.

## Service requirement + lifecycle (M3-C-L verdict)

`PresentMonAPI2.dll` is a client of the **PresentMonService** process (named
pipe + shared memory). M3-C-L feasibility (probe
`tools/validate/m3c-presentmon-probe.js`, run 2026-08-06, NON-elevated
shell): **the v2.5.1 service runs STANDALONE as a per-user child process** —
`PresentMonService.exe --shm-name-prefix Local\pm_svc_shm` (the `Global\`
default prefix needs elevation; the session-local prefix works both
non-elevated and elevated) → `pmOpenSession` SUCCESS →
`pmStartTrackingProcess` SUCCESS → `pmRegisterFrameQuery` SUCCESS →
`pmConsumeFrames` SUCCESS (0 frames — the known environment finding below).
The client learns the shm prefix/salt from the service over the control
pipe (no hardcoded names on the client side). No `sc create`/`sc start`
needed; dev mode degrades to the honest "FPS unavailable" when the spawn or
session fails.

Lifecycle: the adapter (`createPresentmonAdapter`) spawns the service lazily
on the first fps-poll with a session-local prefix and kills it on stop()
(app quit). The pipe/shm names are fixed (`\\.\pipe\sharedpresentmonsvcnamedpipe`,
`Local\pm_svc_shm_*`) — one app instance per session is the assumption.

## Tracking mechanism (M3-C-L)

v2.5.1 has **NO `pmStartTrackingAllProcesses`** — tracking is per-pid only
(`pmStartTrackingProcess` / per-pid `pmConsumeFrames`). The client tracks
the **foreground-window pid**: `GetForegroundWindow` +
`GetWindowThreadProcessId` (koffi user32, verified resolvable on this
machine) re-resolved on every poll; a focus change stops the old pid and
starts the new on the SAME session/query (`PresentMonClient.retarget`). The
app's own pid is never a target (it presents nothing); when the desktop is
focused, tracking moves back to the own pid so stale frames from a
backgrounded game are never reported. Process-enumeration aggregation is
explicitly out of scope (documented enhancement).

## Runtime DLL discovery

`findPresentMonDll()` tries, in order: `PM_API2_DLL_PATH` env override →
the packaged `resources/app.asar.unpacked/tools/presentmon/` (asarUnpack —
native DLLs need real files) → `tools/presentmon/` relative to cwd (dev) →
relative to the app dir → `PresentMonAPI2.dll` in the app dir.
`findPresentMonService()` looks for `PresentMonService.exe` NEXT TO the DLL
(same-version guarantee). The binaries are TRACKED (un-gitignored in
M3-C-L) and shipped in the EXE (build.files + asarUnpack), with the MIT
license in THIRD_PARTY_NOTICES.txt.

> **Packaged EXE note (superseded):** M2b's F8 note ("tools/presentmon/ is
> gitignored and excluded from the build") is GONE since M3-C-L — the DLL +
> service exe ship in the EXE and the adapter spawns the service itself.

## Live-capture checkpoint results (2026-08-05, A770, driver 32.0.101.8861)

`tools/validate/presentmon-capture.js` + the PresentMonService console-mode
run (session-local shm prefix — the Global\ default needs elevation and
crashes the service for standard users). Full chain verified working:
`pmOpenSession` → `pmStartTrackingProcess` → `pmRegisterFrameQuery` →
`pmConsumeFrames` all return SUCCESS; the service log confirms the ETW
providers enabled with no errors, and DXGI **device-usage events** are
delivered to the session.

**However: no frame events were captured from ANY target on this machine**
(Electron GPU process, Chrome with a live CSS animation, PresentMon's own
UI). Root cause, pinned with raw ETW captures independent of PresentMon
(`logman start -p Microsoft-Windows-DXGI 0x3`, tracerpt): **this system
emits NO DXGI Present events at all** — 0 `Present_Start/Stop` events over
multiple 6 s windows while Chrome/Electron were actively animating
(DXGI events DO flow: DeviceUsage etc.; the DWM provider is fully active at
~44 events/s, so presents happen via the DWM composition path and the
app-side DXGI instrumentation is silent). PresentMon's own console app and
UI capture nothing on this machine either — an environment finding, not a
client defect.

Metric export findings (pmRegisterFrameQuery, verified by bisection):

| Metric set | Result |
|---|---|
| PRESENTED_FPS alone | OK |
| GPU_BUSY alone | OK |
| PRESENTED_FPS + GPU_BUSY | OK |
| DISPLAYED_FPS (any combo) | QUERY_MALFORMED (not exported) |
| PRESENTED_FRAME_TIME / DISPLAYED_FRAME_TIME (any combo) | FAILURE (not exported) |

The client's primary query is `[PRESENTED_FPS, GPU_BUSY, PRESENTED_FRAME_TIME]`
with a verified fallback ladder down to `[PRESENTED_FPS]`; on this machine the
client settles on `[PRESENTED_FPS, GPU_BUSY]` and `frameTimeMs` is null. On a
machine that emits present events (the standard PresentMon environment — a
game, any DXGI presenter), `poll()` returns real fps/frameTimeMs/gpuBusy
samples; elsewhere it returns null and the Monitoring page shows "FPS
unavailable" instead of crashing.

Checkpoint verdict: client + service integration proven end-to-end (session
to consume); live fps numbers unavailable on THIS machine because the OS
emits no app-side present events — expected to work on a normal game session
environment (e.g. a game running on the same box).
