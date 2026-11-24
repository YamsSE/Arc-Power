# Tauri / WebView2 migration

> Version 1.3.0 release and 1.2.5 in-app upgrade contract:
> see [v1.3-rust-migration-release.md](v1.3-rust-migration-release.md).

This is a transitional host migration. The main Arc Power interface, telemetry
HUD, quick panel, recording toast, recording status pill and startup splash run
in Rust Tauri 2 / Windows WebView2 windows. Existing TypeScript pages, HTML,
styles, charts, assets and public bridges are retained. Electron remains the
compatibility service broker for legacy channels that have not migrated. Rust owns GPU
apply (supported scalars, fan, lock, VF, listed and advanced power and voltage routing, and strict single-control temperature applies; every other temperature-containing request still uses the broker), Sysman voltage, the native Display read and
composed apply surface, native telemetry
lanes, the tray and host shortcuts, suspend/resume notifications, the native
recording capture/editor/hotkey/screenshot engine, native fan-resume restore,
the native RTSS OSD publisher, RTSS startup registration and profile/frame
limits, native clip playback and thumbnails, startup
registration, OBS streaming and the native persistence/device services. This is
**not an all-Rust backend or an Electron-free distribution**.

## Build and run

Prerequisites: the existing Arc Power dependencies, Windows x64 MSVC/SDK,
WebView2 runtime, Rust stable, and the locked isolated frontend dependency.
Install the latter with `npm ci --prefix src-tauri/frontend-deps`.

On this development host the Rust toolchain is isolated in the sibling
`rust-tools/{cargo,rustup}` directory. The launch script configures the installed
MSVC 14.44 and Windows SDK paths without changing global environment settings.

```powershell
# Build only; does not start GPU services or the product.
./scripts/run-tauri.ps1 -BuildOnly

# Start the real WebView2 frontend with the existing isolated mock backend.
./scripts/run-tauri.ps1 -Mock

# Start the real hardware service path; this is an explicit runtime action.
./scripts/run-tauri.ps1
```

The development host discovers its compatibility runtime from its compiled
checkout root; the launcher can override those fixed absolute paths in debug
builds. Release builds accept only the fixed `compatibility-backend` directory
beside the host executable, with a required `resources/app.asar`. The renderer
cannot choose an executable, command,
filesystem root, broker destination, session token or window role. The host
generates a fresh 256-bit session and a private local named pipe with a random
128-bit name. The pipe rejects remote clients, permits only the current user
and SYSTEM, and verifies the connected process ID against the spawned service.
The existing frame authentication is also required. Child stdout/stderr carry
logs rather than RPC; inherited GUI stdin was rejected after a runtime probe
showed immediate EOF on this Windows Electron build.
There is no HTTP server or renderer shell/filesystem plugin.

`src-tauri/target/debug/arc-power-tauri.exe` is a development host requiring the
checkout. Release builds can be staged with `scripts/build-tauri-dist.mjs`: the
native executable and root icons sit beside the complete remaining
`compatibility-backend` payload. The build creates native NSIS self-extracting
`Arc-Power_Portable.exe` and `Arc-Power_Installer.exe` wrappers plus an
`Arc-Power_Tauri.zip` containing both. The wrappers extract and run the Tauri
host; the portable wrapper passes its own path as the portable build marker.
The distribution does not use Electron Builder to create its wrappers.
This preview retains the existing application's administrator model; debug
mock development stays unelevated. A standard-user WebView host with a separate
privileged Rust service remains future work.

Native setup installs the staged host and compatibility service under the
current user's Local AppData, writes the uninstall registration, and creates
Start Menu plus optional Desktop shortcuts. The installed host handles
`--uninstall` natively and defers removal until its process exits. The native
installed-update path also runs before WebView startup. Compatibility services
remain required for channels that have not migrated.

The legacy 1.2.5 updater uses the exact `Arc-Power_Installer.exe` and
`Arc-Power_Portable.exe` names. The native wrappers forward its update arguments
to the staged Tauri host and carry the full compatibility payload.

`--test-mock-fixtures` explicitly includes fixed B580 mock data in the service
resources for isolated packaged verification. It does not select mock mode on
normal launches; tests must launch `--mock`. Native installation and removal
have not been run on a desktop in this migration turn. The compatibility
backend remains Electron until its remaining channels migrate.

For an isolated packaged UI probe, launch `--mock --ui-test-port=9347`.
The validated mock-only port is passed directly to WebView2 and bound to
loopback; normal launches leave diagnostics disabled. Runtime 150 and later
ignore diagnostic environment overrides in elevated hosts, as explained in
[Microsoft's response](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5645).
The test option survives a mock maintenance restart, permitting verification
through a fresh portable extraction. It cannot be enabled without `--mock`.

## Frontend contract

`scripts/build-tauri-frontend.mjs` compiles the actual `src/preload.cjs` with an
esbuild alias from `electron` to
`src/renderer/platform/tauri-electron-adapter.ts`. It does not reimplement public
methods or substitute mock return values. The source preload's 153 invokes, 20
subscriptions, defaults, argument ordering and unsubscribe behavior remain
unchanged. A generated native allowlist is derived from that same source and
checked against expected counts during the build.

The adapter registers the native event listener before loading the preload and
existing `app.ts`. It announces renderer readiness only after the application's
synchronous event subscriptions exist. Original page code continues to use
`window.arcPower` through `renderer/ipc.ts`. The shared tagged wire codec
preserves `undefined`, nonfinite values and other supported wire types instead
of silently changing optional parameters to JSON `null`.

Rust derives each role from its native window label and exact packaged document
URL. Main uses `renderer/index.html`; auxiliary labels carry unique generations
so late events cannot affect recreated windows. Both the generated role allowlist
and the broker's registered channel manifest must authorize a request. Existing
backend argument validation, frame permissions and hardware safety checks still
run against the corresponding proxy identity. Splash uses its original distinct
preload. Its two guarded commands are published before the startup update decision;
the final device-service manifest extends that early readiness later.

## Native lifecycle and media

Requests and responses use schema version 1, session authentication, bounded
newline-delimited frames, monotonic request IDs and response timeouts. Mutations
are never automatically replayed after a timeout or disconnect. Broker failure
rejects outstanding requests and is shown in the frontend.
The Windows transport uses explicit overlapped reads/writes: cloned synchronous
pipe handles blocked native focus callbacks in the real startup test. Native
events now enter a bounded worker queue; writes have a cancellation timeout.

The native main window delegates close decisions to the existing service policy
so close-to-tray behavior and shutdown cleanup remain backend-owned. Native
window acknowledgments keep the compatibility proxy's state current. Main
window titlebar dragging uses native Tauri operations while excluding buttons
and other interactive elements.
In normal non-mock Tauri runs, `window-minimize` is handled by the native host
and sends the existing minimize event to synchronize the compatibility window
proxy. `window-maximize-toggle` uses the Tauri window's current maximize state;
the existing host `maximized-changed` and bounds events synchronize the proxy.
`window-close` is handled by the native host and emits the existing `close`
event to the compatibility proxy. The broker still owns close-to-tray policy
and shutdown cleanup. Mock runs keep the broker path, preserving `--ui-verify`
counters.

Reload and navigation release renderer-owned recording runtime leases through
the existing service lifecycle hooks. A native WebView2 process failure requests
service shutdown and cleanup rather than automatically replaying GPU operations.
Maintenance relaunch uses a fixed self executable and a bounded helper that
waits for the old host process to exit before starting a new WebView2 instance.
Only the explicit mock/profile/cache/reset flags pass through that helper.
Scheduled `--boot-apply` launches take a separate headless route through the
existing compatibility backend; no WebView2 or main window is constructed.
This route uses the same fixed runtime discovery and inherits the scheduler's
token. Its classification/discovery tests never execute a real boot apply.

Recording URLs remain opaque IDs. On Windows the adapter normalizes them to
`http://arc-power-media.localhost/{clip|thumbnail}/{id}`. The native custom
protocol passes the original opaque URL, request method and range to native
`recording_playback::serve` in non-mock Tauri runs. Mock runs proxy through the
compatibility broker's safe media handler. Both routes resolve clip metadata
and authorize the recording-root path; filesystem paths are not accepted by
the native protocol. Responses are limited to bounded 4 MiB media chunks;
GET/HEAD, MIME types, byte-range status and headers are preserved. Whole
recording files are not passed through ordinary frontend invoke calls.

## Acceptance status and remaining gates

Source-level bridge coverage and protocol tests do not prove full feature
parity. In particular, a successful host build is not proof of GPU writes,
game overlay behavior or a working installer. The native recording engine has
passed live machine-info, Instant Replay start/stop, FFmpeg trim, editor trim
and global-hotkey checks; the full Recording page, replay save through the real
UI, window screenshot capture through the UI, and long clip seeking still need a
desktop verification pass. Native `startup-get`/`startup-set` passed a live
Run-key enable/read/disable round trip in the Tauri host. Native
`fan-resume:get`/`set`/disable passed live through the Tauri bridge; a real
sleep/resume fan write was not performed. The native RTSS publisher claimed,
wrote and read a classic OSD slot with RTSS running; the frametime graph and
percentile rows are native and unit-tested, but a full host telemetry session
against the RTSS renderer still needs a desktop pass. Native RTSS profile/
frame-limit reads and writes are implemented with read-back verification and
fail-closed external-edit handling; a live RTSS apply/restore pass still needs
RTSS running and the corresponding elevation approval.

Before distribution, verify all ten pages, multiwindow state propagation,
titlebar/tray/close/startup behavior, themes/DPI/window restoration, real GPU
readbacks, profile apply and reset, suspend/resume, driver download/install,
recording/replay/edit/share/clipboard and long clip seeking, OBS credentials,
maintenance/restart/update, and resource discovery outside the checkout.

Native `get-capabilities` and `get-current-settings` now read the trusted IGCL
snapshot for stock and advanced mode, including the native device-limits
finalization for listed Alchemist cards. Capability reads include the reversible
fan-table/fixed probe and share Electron's success-only `fan-probe-cache.json`;
a refused write is reported as read-only and is never persisted as success. For
cards whose properties hide fan control (B580/A770-style), native capability
reads run only when Electron's success cache already exists; otherwise the first
read defers to the broker, so the two hosts never probe the same fan
concurrently. `power-limits:read` and `voltage-offset:read` are native,
BDF-matched Sysman reads; mock mode and native read failures still use the
Electron broker. The probe needs the same elevation as the Electron backend.

The Monitoring log-to-file append is native and preserves Electron's exact
22-column header/line format, local timestamps, decimal-GB columns, header
recreation and `{ ok:false, error }` failure shape. Advanced-mode acceptance is
read/written natively, and read-only `waiver-get` follows the same capability
eligibility. OC mode selection is native for the scalar and per-GPU map, with
the same expected-key/expected-mode checks; native capability reads re-derive
ranges from the persisted mode. Native `get-capabilities` also merges the
shared refusal cache's learned temperature ceiling into the returned ranges
(`merge_temperature_refusal_cache`): a valid ceiling lowers `tempLimitC`'s
`max` (and its `default` when that exceeds the ceiling) and is published as
`learnedCeilings.tempLimitC` beside the cache generation and identity.

The GPU apply safety core is native for elevated applies: scalar V2 controls,
fan auto/curve/fixed, GPU lock, custom VF curves and waiver acceptance. Listed
cards use the native device-limits finalization; advanced PL/TL above the stock
DriverStore ceiling route through the bundled 2023 runtime when the value is at
most 315 W, and >315 W uses the native Sysman sustained/burst pair. Negative
Alchemist voltage uses the BDF-matched Sysman frequency target sequence with the
-200 mV write floor, waiver gating and read-back verification; positive/zero
voltage clears a stale Sysman offset before the IGCL write. Renderer profile
applies and tray "Apply active profile" are native in elevated, non-mock runs;
boot applies stay Electron-owned because they run in a short-lived process
before the native host and its broker initialize. Unelevated hosts and any
profile the native host cannot prove still use the Electron broker. Electron and
native applies share the `Local\ArcPower-GPU-Apply-v1` named mutex, including
abandoned-owner recovery. Electron's direct, boot, reset-to-defaults and
delegated profile/tray broker transactions also run through one in-process FIFO
gate: an apply holds it from capability preflight through publication of any
learned refusal, and reset holds it for the whole reset transaction. The named
mutex protects the actual cross-process writer; it is not held while a parent
waits for its apply worker.

In a normal Tauri run the temperature refusal-cache authority is the native
host's process-lifetime store (`profile_apply_preflight.rs`): a volatile,
identity-bound cache that the compatibility service reads, records into and
poisons over the `temperature-refusal-cache-read`/`record`/`poison`
native-store RPC, each operation re-resolving the target against a fresh
IGCL inventory. Standalone Electron keeps its own process-local cache, and
separate Arc Power processes still do not exchange learned refusals. The
broker FIFO keeps each process's capability preflight, setter result and
refusal-cache publication ordered as one transaction. A temperature refusal
is published before follow-up side effects; if publication fails, the result
is malformed, or a temperature apply throws before returning a result, that
backend instance blocks further temperature writes until restart. In a
normal Tauri run the latch lives in the native store: a failed publication
poisons the whole session through the `poison` RPC, and if that poison cannot
itself be acknowledged the compatibility service exits instead of continuing
without a cache authority. Partial mixed
results still publish any actual driver refusal, while pure capability/config
refusals do not. Reset-to-defaults uses the same broker FIFO and fails closed
if a Sysman voltage offset that may be present cannot be read or cleared; only
an explicit `unsupported` result skips the companion check. Strict
single-control temperature applies are now native for elevated, non-mock
hosts: the request borrows a broker-side lease
(`__native-temperature-apply-lease:begin`/`cancel`/`finish` in
`src/main/native-temperature-apply-lease.js`) that keeps the broker apply
turn held across the whole transaction and returns a fresh identity-bound
snapshot — schema version 1, an epoch, the transaction sequence, the cache
generation, the physical target row, the attempted settings, the
authoritative Celsius range, the learned ceiling and the OC mode. The native
host validates that snapshot against the request and its own live inventory
(`validate_temperature_lease_snapshot` in `services.rs`) before any setter,
and the finish acknowledgement that publishes any learned refusal is
verified field-by-field (`temperature_finish_ack_matches` in `main.rs`),
including monotone ceilings and generations and the exact attempted value;
if the native path declines before a setter, the lease is finished as
`not-applied` and the request falls back to the ordinary broker apply.
Every other temperature-containing shape — mixed controls, profile-shaped
or multi-key payloads — still delegates the whole payload to Electron after
target proof validation and before any native setter. Host-originated profile
and tray applies run the same shared preflight planner; boot applies remain
broker-owned. Other supported direct apply controls remain native.

The Rust `profile_apply_preflight.rs` module owns the shared refusal-cache
consumer. A snapshot must carry schema version 1, a monotonic transaction
sequence, the broker-resolved physical target row, the attempted temperature
value, the authoritative Celsius range, the per-control result, and whether
refusal-cache publication committed. The consumer checks the target against
the request proof, only lowers a valid grid-aligned ceiling, and latches
cache publication or result failures for the rest of the process session.
The staleness gate runs before validation: an out-of-order snapshot is
ignored wholesale, so a delayed older response can neither move the ceiling
nor poison the cache after a newer snapshot has landed. The module also
defines the profile-apply decision (`plan_profile_apply`: a poisoned cache
refuses the request's controls with `refusal-cache-unavailable`, a learned
ceiling is merged against the capability range, and a refused temperature
control is removed from the routed settings). That decision is not wired
into a live profile route yet; its consumers are the module's own tests.

The single transaction owner this routing required now exists for strict
single-control temperature applies. The native host owns a process-lifetime
apply FIFO (`backend/apply_transaction.rs`): a pipe client reserves a turn
with `begin`, confirms it with `activate`, runs its body, and releases with
`finish`; a lost response must be answered with a pre-body `cancel`, whose
request ID is tombstoned for ten minutes so a delayed `begin` cannot be
admitted, and a tombstone-table overflow closes the coordinator instead of
risking a late admission. Queued waiters are bounded, sequences stop at the
JavaScript safe-integer range, and an indeterminate outcome or host shutdown
fails the coordinator closed (`close_unknown`). Electron's broker applies
delegate their turn to that coordinator over the pipe
(`apply-transaction-begin`/`activate`/`finish`/`cancel`), keeping the
existing preflight, setter result and cache publication inside the granted
turn, and native `apply-settings` bodies run inside the same coordinator
through `acquire_internal`, releasing the turn before a delegated broker
operation re-enters it.

The native direct-apply path now requires a selected PCI/BDF identity and
checks it across its capability, IGCL, legacy and Sysman sessions; duplicate
physical matches fail closed. Direct Tauri applies without sufficient proof are
rejected; a proven request may delegate before mutation when the fan-probe cache
is missing. Renderer profile applies and native tray applies use that same proof.
Boot applies remain broker-owned and still need their own cross-host identity
audit.
Legacy runtime capability discovery checks exported setter availability only;
it does not set a waiver or prove that the target driver will accept a write.
The selected-target apply path checks consent and the required per-control
exports before replaying the waiver. Unsupported-GPU requests are refused
before setters, and mixed requests needing Electron's partial-refusal behavior
are delegated before mutation. These paths need live target verification.
Sysman power-pair writes require a readable restorable before-image, including
enabled flags. A failed write is compensated only when read-back still matches
the requested pair, and restoration is verified; an unknown or third state is
reported as cleanup pending. Sysman has no compare-and-set, so compensation is
best effort against external writers. Voltage failures after a setter report
that driver state may have changed; full voltage-mode rollback remains unverified.

The Graphics surface (`graphics:get` / `graphics:apply`) is native for elevated,
non-mock hosts: the IGCL 3D features, the DxgKrnl shared GPU/NPU memory
override, and an RTSS-first global FPS limit with driver fallback and
read-back verification. The post-apply `graphics:state-updated` read-back is
pushed to the main window and the advanced overlay. Sharpening is written
in-process through 3D feature 7 instead of Electron's isolated child helper;
the loss of crash isolation is documented in `backend/graphics.rs`. Arc Sleep is
native in the same hosts (see below), so the narrowed gate delegates - before any
driver, RTSS or registry access - only for a journal record this build cannot
parse, which belongs to a foreign owner. Arc Sleep journals, a pending Base Cap
change and an enabled Base Cap are handled natively. The Base Cap control is
routed through the controller's `Transaction` (`FrameLimitOwner`), the only
writer of the global limiter and the recovery journal; a failed companion
control rolls the Base Cap back through the same owner. Without a controller the
native path still delegates a frame-limit apply once any base cap object exists.
The Arc Sleep panel's independent `arc-sleep-base-cap-get` read rides the same
guard and transaction, answering from the controller (RTSS-only while it owns
that limiter). The fake-IGCL/fake-registry/fake-RTSS suite covers the full
read/apply surface; a live B580 Graphics-tab pass (including the shared-memory
restart and a real RTSS limiter apply/restore) remains a desktop gate.

The elevated, non-mock Display read is enabled for complete candidates accepted
by a response preflight. `backend/display.rs` reads display
properties, the `deviceKey|display|<encoder>|edid|<fnv>` identity, connection
type, active/attached/dongle/dithering flags, HDCP/HDR capability bits, a
plausible active timing, the `ctlGetSetDisplaySettings` GET (quantization range
plus its Controllable option list), the EDID / panel-descriptor monitor name, the
`ctlGetSetWireFormat` GET (canonical, de-duplicated wire formats and BPC depths,
with `currentUnavailable` kept distinct from a zero depth), the
`ctlPixelTransformationGetConfig` output format (which overrides the legacy wire
slot when the driver proves a model or `bitsPerColor > 0`), scaling
(`ctlGetSupportedScalingCapability` plus `ctlGetCurrentScaling`, retried at
version 0 only for `ERROR_INVALID_ARGUMENT`/`ERROR_UNSUPPORTED_VERSION`) and
retro scaling (adapter-scoped caps plus the `Get` settings pair), and per-output
Arc Sync monitor/profile GETs (with the full-loader gate for profiles), plus
global VRR advertised modes and GET readback, re-enumerating
output handles on every read (never cached) and degrading each control on its
own. Absent driver exports skip the whole block that needs them. The scaling read
also resolves the persistent Arc Power selection from
`%APPDATA%\ArcPower\DisplayScalingSettings\<sha256(displayKey)>.json` (schema
`{version:1, displayKey, state:{identityScaling, nativePreferredScalingType,
customX, customY}}`): a matching identity selection yields
`display-scaling`/`arc-selection`. Electron's broker persists invalidation when
the driver has overridden a saved identity selection (`identityScaling: false`,
coordinates preserved). The staged Rust reader reads the same record without
writing and returns a conditional invalidation intent containing the observed
record, stable display key, observed `Enable`/`ScalingType` and preferred-type
fingerprint. Electron and Rust share the crash-recoverable Windows mutex
`Local\ArcPower-Display-v1`: Electron holds it over the whole `display:get`
read including invalidation persistence, and over each `display:apply` driver
and selector-store transaction. The native reconciliation helper requires a
live lock guard, re-enumerates the active outputs, requires one exact
encoder/EDID identity, re-reads `Enable`/`ScalingType`/preferred fingerprint,
compares the exact saved selection and only then conditionally clears the
identity bit. The result is tri-state. Every pre-write refusal - a multi-record
reply, a duplicate identity, an unprovable driver tuple, an unreadable record, a
mismatched `Enable`/`ScalingType` state or a different saved selection - is
`DeclinedNothingWritten`: nothing was touched, so the candidate is handed back
to the broker, which persists every stale record inside one of its own reads. A
hard error there would only strand the Display view. There is still no durable
multi-file transaction, so a reply carrying several stale selectors is declined
before the first record is written instead of being half-healed, and the broker
heals all of them. Only the conditional commit loop can produce
`FailedAfterWrite`, which fails closed and is never retried across hosts. The
Node host also queues same-process async Display work
before acquiring the Windows mutex, because mutex ownership is reentrant on one
thread. Waits are bounded, and `WAIT_ABANDONED` is recovered by re-reading the
driver and store before acting. The elevated, non-mock service now owns
`display:get` only for candidates accepted by the response preflight, while
holding the shared guard through conditional reconciliation. A staging,
ownership or pre-write reconciliation decline delegates to the broker, which
revalidates the expected device key under its own Display lock before reading.
Once reconciliation's commit loop starts, a moved record or a write failure
fails closed because a store write may have happened. Staged reads cannot mutate
state before ownership is accepted. The store rejects identity/schema mismatches and uses
atomic file replacement for its writes.

`display_color_state.rs` reads Electron's per-display
color-intent records, including strict schema, value/step and identity checks and
the per-group last-sent flags. Those flags describe Arc Power's prior intent,
not driver read-back. The staged Display payload combines it with a bounded,
two-phase IGCL capability query and the matrix/RGB LUT classifier, including
ambiguity and sampling checks. This read writes no driver colour control; the
routed colour apply surface is described below. Fixture
tests cover saved records, query failures, and payload projection.

The elevated, non-mock service routes the composed `display:apply` order.
`display_apply_plan` builds the keyed sequence in Electron's own execution order
- quantization, wire format, the Scaling Mode group, the Retro write, the two
colour groups, boolean Variable Refresh Rate, the global VRR mode - and declines
the whole request when it names any control this build does not own, so an owned
subset is never applied on its own. The routed set, per phase: quantization and
wire format; native `scalingMode` for identity, centered, stretched and
aspect-ratio-centered-max, with an agreeing `displayScalingMethod` alias or the
bundled `scalingMethod` disable; native display colour for one to four of
hue/saturation/brightness/contrast plus the `replaceExistingColorSettings` flag;
native Custom scaling; the UI's Retro-entry pair (`scalingMode: 'identity'`
plus an enabled `scalingMethod`); and the composed Apply-all. Retro entry uses
the adapter-level Retro transaction without issuing an ordinary scaling
setter. Electron only mirrors its result under `scalingMode` and
`displayScalingMethod` when the legacy method alias is present; the current UI
entry pair omits that alias, so only `scalingMethod` appears in `perControl`.
The composed request runs every step under one `DisplayLockGuard` with one
staged read and one final read,
continues past a failed control without rolling a sibling back, never retries
the broker after the first SET, and returns an error instead of a fabricated
`displayState` when the final read is unverifiable. The legacy `vrrMode` Arc
Sync profile is accepted only when it is the request's sole control. Every
native request derives a fresh native adapter proof. Any failure after entering
a setter returns an error without retrying through Electron.

Three places spend a 400 ms settle before their verification GET: the Scaling
Mode transaction once per accepted SET (so a full Custom change spends two),
standalone Retro Scaling, and the Arc Sync transaction once per successful SET.
A full Custom change with a Retro exit and a Variable Refresh Rate write
therefore spends about 1.2 s in settles, and the worst reachable failing path
spends four, about 1.6 s. A normal Apply-all cannot reach the shared Display
mutex's 10 s acquire cap; a hung peer holding that mutex still can.

Preflight declines occur before a driver or saved-state write. No display
driver control is written by the read: it shares
`ctlGetSetDisplaySettings`, `ctlGetSetWireFormat`,
`ctlGetCurrentScaling` and `ctlGetSetRetroScaling` with their SET surfaces but
never sets `Set`/`ValidFlags`, `Get = 0`, `Operation = SET` or a scaling
`Enable`.

The staged Display reader uses a Display-specific selector requiring a complete
present-device discovery and a unique active package matching the selected class
driver's version and hardware identity. It rejects the newest-folder and
environment fallbacks when that proof is missing. This stricter selector has
fixture coverage but has not been exercised against a live driver. Native
enumeration now returns an error distinct from a valid empty list. A global VRR
GET that would require Electron's scope-selection write returns an error from
the native staging path before any native mutation. Keyed requests fail closed
instead of retrying Electron after releasing the shared lock.

`windows_display_modes.rs` stages read-only Windows output and mode inventory
with bounded enumeration, completeness tracking and identity matching. When an
active IGCL output lacks timing, a complete, untruncated Windows inventory can
supply presentation timing for a unique normalized EDID-name match. This label
match is not physical output proof. The Windows mode inventory and mode
controller remain available as shared functionality; Display Super Resolution
is no longer a product option or migration requirement.

A private, fake-backed modeset transaction requires the shared Display guard,
complete Windows inventory, matching Windows output identity and expected
mode, supported target, and read-back. It conditionally compensates only while
the observed output and mode still match. Its private Windows writer rechecks
identity and current mode immediately before User32, with fake FFI coverage.
There is no service route: Windows identity alone does not prove an IGCL output
mapping, and Win32 has no atomic compare-and-write against external writers.

The removed Display Super Resolution feature no longer appears in the Display
read/apply contract, renderer controls, or native migration modules. Existing
`%APPDATA%\ArcPower\supernative-display-state.json` records are left untouched:
the application no longer reads, migrates, rewrites, or cleans them. Arc Super
Resolution on the screen post-processing page is a separate feature and remains
available through `postprocess_sharpening.rs`.

`display_apply.rs` owns the fake-backed quantization transaction and its
identity-pinned IGCL adapter. The backend reopens the adapter by captured
PCI/BDF identity and re-enumerates output handles by stable encoder/EDID key
for every check, GET and SET. Its setter writes only `QUANTIZATION_RANGE`
(`Set = 1`, `ValidFlags = 1 << 3`); the transaction verifies read-back and
only attempts conditional compensation when the current value still proves
its own write. A successful setter with a nonmatching read-back reports
`silentNoop`, matching Electron. The Display settings FFI buffer preserves
Electron's 148-byte `Size` and adds the same zeroed 16-byte tail allocation;
the IGCL ABI struct itself stays 148 bytes. Fake FFI checks the declared size,
requested flag and range, and that the tail is zero on entry and addressable
by the callee.

Every Display transaction - quantization, wire format, the Scaling Mode group
(ordinary, Custom, Retro exit), standalone Retro Scaling, display colour, global
VRR, Arc Sync profile - requires a live `DisplayLockGuard` at the
transaction-core and native-adapter seams. The service acquires the shared
`Local\ArcPower-Display-v1` mutex before each transaction and retains it
through identity checks, read-back, any conditional compensation, and
production of the complete Display response; a composed request holds it once
across the whole sequence. The process-local mutex is only an additional
same-process guard. Global VRR requires one active verified display,
an advertised mode and the same fresh physical adapter proof used to reopen IGCL. Only a
pre-SET decline may delegate; after a SET attempt, the native result is
returned with the complete locked Display read-back or a hard error. The
registry fallback runs only after `ERROR_INSUFFICIENT_PERMISSIONS`, resolves
the class entry by PCI/subsystem identity, and reports success only after IGCL
read-back. The Display UI can send one control or one composed Apply-all; both
are routed by the same plan. Boolean
Variable Refresh Rate uses the Arc Sync profile transaction, setting
RECOMMENDED when enabled and OFF when disabled while preserving the current
timing fields. The native service also accepts an isolated Arc Sync `vrrMode`
profile patch, which is not a shape the Display UI generates - the UI sends the
boolean `variableRefreshRate` instead. Fake tests cover the global VRR
transaction, registry seams, Arc Sync profile
and boolean Variable Refresh Rate setter/read-back behavior; no live registry
or GPU write was performed. An unverified post-apply
Display response fails closed with the shared Display read error.

The quantization adapter normalizes Electron's narrower `physicalTargetOf()`
proof to canonical PCI/BDF identity and accepts direct PCI aliases only when
derived from that identity. PNP-first aliases require a unique match in a fresh
inventory; a proof object's `deviceKeys` or `legacyDeviceKey` fields cannot
claim an alias. Conflicting PNP, PCI, BDF, LUID or legacy-key data is rejected.
A fake-tested alias rewrite helper requires exactly one current inventory row
and verifies that it is the selected device. The composed response projection
reports each control separately and rejects malformed patches. The active
service route returns every control's own outcome plus the complete fresh
Display state under the shared lock.

`display_global_vrr_apply.rs` owns the adapter-wide Global Variable Refresh
Rate Mode transaction. If the direct IGCL SET returns
`ERROR_INSUFFICIENT_PERMISSIONS`, its registry fallback resolves a unique
display-class `MatchingDeviceId` by PCI vendor/device and, when available,
subsystem identity; it never assumes the `0000` key. A successful registry
write still requires a fresh IGCL read-back, and the per-control response keeps
Electron's `writeTransport: registry` and `silentNoop` fields. The elevated,
non-mock service routes `globalVrrMode` after full-response and capability
preflight, either isolated or as one step of a composed request.

The private active-output resolver still requires a unique active IGCL encoder
identity, while Electron can fall back to an EDID match when Windows reports
exactly one corresponding active mode. That fallback needs equivalent proof
or an explicit refusal result before routing. The shared Display mutex
serializes cooperating broker and native transactions. It cannot exclude Windows
Settings, Intel Graphics Software or driver utilities, so the accepted model is
a bounded external-writer window, not atomic exclusion - the same terms already
accepted for quantization, wire format, Retro, global VRR and Arc Sync now cover
`scalingMode` and display colour as well. Inside that window the native path
writes under the shared guard, verifies its own read-back, and refuses to
restore over a value it did not write. The native scaling writer is the
strongest of these: a conditional set-if-current, a durable selector commit and
compensation. Arc Sync and Retro Scaling re-read and compare their current IGCL
records inside the setter session; quantization and wire format re-read before a
separate setter call. These checks catch changes observed before the setter and
their compensation paths avoid restoring over a different value, but an external
change in the final GET-to-SET window can still be overwritten. Global VRR's
IGCL and registry setters do not compare the prior mode before writing; their
post-write read-back verifies the outcome but does not exclude a concurrent
writer.

Wire format now has a private native adapter and fake-tested transaction with
PCI/BDF and active-output revalidation, model/depth read-back and conditional
compensation. Its SET ABI fixture verifies the nested headers and zeroed tail;
the elevated, non-mock service routes `wireFormat` patches, isolated or inside a
composed request, after full-response preflight. Scaling has a native adapter
and guarded selector-store coordinator, including deferred selection and
fail-closed handling when prior custom coordinates or durable state cannot be
proven, and it is connected to `display:apply` for the whole Scaling Mode group.

Color adjustments run through a native matrix/LUT setter with bounded, owned LUT
data, a guarded intent-store write, and sibling merge from the persisted intent
(`hue`/`saturation` and `brightness`/`contrast` merged into one SET per group,
`hueSaturation` before `brightnessContrast`). `replaceExistingColorSettings` is a
flag, never a control and never a `perControl` entry; it is only meaningful
beside a colour control, so a flag-only patch declines to Electron. Success
messages are byte-identical to Electron's. The response retains
`readback-unavailable`: persisted values record Arc Power's sent intent, not the
effective driver state, and no rollback is claimed without a baseline. This path
has fake and seam coverage only; with Custom it is the least proven of the routed
controls.

The renderer now forwards its stable `deviceKey` with each `display:get`
request. The native read requires that key and compares it with a freshly
opened adapter's canonical PCI/BDF identity. If native staging or response
preflight declines before reconciliation, the broker revalidates the expected
key against its current inventory and a fresh IGCL adapter enumeration under
the Display lock before reading; it does not use an ordinal-only fallback.
Once reconciliation's commit loop starts, a refusal or error fails closed. The native
read also counts active adapter/encoder pairs before loading per-display intent;
duplicate encoder handles are returned without `identityVerified` or a
`displayKey`, even when EDID data differs, and those candidates decline before
reconciliation. Named inactive outputs and named active outputs without IGCL
timing also decline before reconciliation, because Electron may promote them or
supply timing through its Windows mode fallback. The staged apply transaction
independently rejects an ambiguous active output before reading or writing its
setting. These gates and the service bridge are fake-tested.

Native Display live coverage is partial, and the boundary matters. Two things
are live-proven, on a B580 with the Electron broker suspended
(`NtSuspendProcess`) for the whole window: a keyed native `display:get`
returned a complete payload and passed native ownership preflight, so
**ownership of the read** is proven; and a native `scalingMode` request was
handled with the broker still frozen, returning `deferred:true` /
`verification:"native-preference"` / `selectionSaved:true` while the driver's
live `scalingMode` stayed `identity`, because no GPU resize is needed at the
panel's native resolution. What that proves is the **durable selector
commit** — the `DisplayScalingSettings` record plus its preference read-back,
the `is_deferred` contract in `display_scaling_apply.rs` — and nothing more. It
is also the only display change this evidence can attribute, and it was a
durable preference commit rather than a driver SET: `deferred:true` with the
driver's live `scalingMode` still `identity` means no driver resize occurred, by
construction, because the panel was already at its native resolution. The
user's own manual Display pass went further, but not provably: its colour apply
is recorded as persisted intent, not as a driver write.
`DisplayColorSettings/0aaa….json` (mtime 09:47:20) holds neutral values with
both groups sent, so a colour apply ran and its intent persisted, yet no host
apply log exists for it, no `perControl` envelope was captured, and nothing
attributes it as native or delegated — so whether that colour write reached the
driver is unknown. Driver-level SET coverage therefore remains unproven:
quantization, wire format, the coupled Retro exit, standalone Retro Scaling,
global VRR, Arc Sync profile and boolean `variableRefreshRate`, display colour,
Custom scaling and the composed Apply-all have fake-IGCL, seam and fixture
proof only, and end-to-end live Display coverage remains a desktop gate. The
individual gates are: quantization read-back and compensation on a real driver;
the wire-format SET plus read-back; the ordinary `scalingMode` conditional
set-if-current at the driver level (its durable selector commit is the one part
already live-proven); Custom's two-step neutral initialization, its skip rules
and its rollback verification; display colour, including the sibling merge and
the absence of a baseline for rollback; global VRR through both the IGCL and
registry transports;
the Arc Sync profile and boolean Variable Refresh Rate setters; the composed
Apply-all's single-lock ordering, per-control continuation and final-read
fail-closed path; and the active-package runtime selector. Custom and display
colour are the least proven of these paths. The shared native adapter resolver
also rejects duplicate vendor/device/BDF matches instead of selecting the first.

### Display divergence: Custom rollback ownership

Custom scaling deliberately diverges from Electron on one point. Rust rolls back
the neutral 100x100 initialization only when a read-back witness is present, that
witness equals the tuple this transaction itself wrote, and a fresh GET agrees
with it. A foreign or unwitnessed read-back is reported as a failure and is never
rolled back. Electron would write the rollback in those cases. The rationale is
that a rollback is a blind write: if the state on screen is not provably ours,
writing over it destroys a value Arc Power did not set and cannot restore, so
refusing is the only safe answer even though it leaves the display in a state the
user has to correct. This is an intentional divergence and must not be documented
or tested as parity. The residual risk it accepts is an ABA: an external writer
landing on the exact neutral tuple after our write would satisfy the witness test
and be rolled back. That residual is accepted under the shared-mutex model, which
already accepts a bounded external-writer window for every routed Display control.

### Display exceptions: requests that still reach the broker

In a normal elevated, non-mock native-owner run, these `display:apply` requests
still decline to Electron:

- Mock and unelevated runs, which stay broker-owned by design.
- Dynamic preflight declines: when ownership, target/output identity or control
  support cannot be proven, the request is declined before any write and
  delegated.
- Shape declines in `display_apply_plan` / `display_scaling_patch`: a
  `scalingCustom` pair without `scalingMode: 'custom'`, a `scalingMode: 'custom'`
  without its pair, `hardwareModeSet: false`, a `replaceExistingColorSettings`
  flag with no colour control, and any unknown or unowned key each decline the
  whole request before any write.

The UI entry pair is native when its raw mode is `identity` and its enabled
Retro method is supported; `identity` selects the Retro branch without a raw
scaling write. Without the legacy alias, Electron returns only the
`scalingMethod` per-control result. A standalone *enabling* `scalingMethod`
combined with another control remains broker-owned because the UI does not
produce that shape.
Mismatched or malformed entry pairs also decline before any native write.

Standalone Retro is otherwise *not* an exception, which is easy to get backwards.
A patch carrying only `scalingMethod` is one control, so `display_apply_plan`
accepts it and emits a standalone Retro step - natively, for both an enabling and
a disabling write, as it was before the Scaling Mode work. A Retro *disable* sent
beside a `scalingMode` write is likewise native, but is consumed as the coupled
precondition inside the Scaling Mode transaction; a composed request also carries
it as a later Retro step, which observes an already-disabled surface and writes
nothing. `vrrMode` is not an Apply-all shape the UI produces - the UI sends the
boolean `variableRefreshRate` - so it is not a UI-reachable exception either.

Native Arc Sleep (`arc_sleep_system.rs` over `arc_sleep_controller.rs`,
`arc_sleep_policy.rs` and `arc_sleep_limiter.rs`) owns the policy loop in
elevated, non-mock Tauri runs. The production adapters supply the monotonic
clock, `GetLastInputInfo` idle time, the renderer telemetry lane's `gpuUtilPct`,
the native RTSS foreground FPS/process rows, RTSS through the single
`RtssProfileController`, and the IGCL feature-2 fallback through the native
Graphics helpers; a policy input the host cannot observe stays unavailable
rather than fabricated. The host constructs one controller, installs it
process-wide, starts it after setup, ticks it from the existing host event loop
(no busy thread), stops it on suspend and shutdown, and restarts it on resume.
`arc-sleep-state-get` (in-memory snapshot) and `arc-sleep-base-cap-get` are
native in an elevated non-mock run, and the panel's saved policy is adopted by
the native controller on its next cadence (the settings store's cached snapshot,
so no settings-file read is repeated per tick). Electron starts its controller
whenever the native host does not own Arc Sleep - standalone Electron, mock runs,
and unelevated Tauri runs where the limiter writers are unavailable - so exactly
one controller owns the limiter and the recovery journal; the native
`limiter-unavailable` snapshot is only a defensive fallback. In a native-owner
run Electron is handed a read-only controller handle (`getSnapshot` only, no
transaction seam), so `profiles-settings-save`, `game-settings-save` and any
delegated graphics apply cannot run `initialize`/`setSettings` and write the same
limiter or journal. A delegated apply that still carries `frameLimit` fails
closed (`limiter-unavailable`) rather than writing RTSS without a recovery
record, because the only delegated case is a journal owned by another writer. A
live limiter apply/restore (RTSS running, elevation, verified restore) remains an
approval gate.

The OBS stream service is native over WebSocket: status, connect/disconnect,
scene list/selection, stream start/stop, microphone mute, and ducking/restore,
with passwords in the native DPAPI credential store.

Native recording owns the Ascent child-process protocol, runtime probe,
settings, video and Instant Replay start/stop, replay save with verified
duration bounding, APM sampling, markers, editor jobs, and recording hotkeys.
`recording_hub.rs` routes the renderer channels, persists clip metadata through
the native recording store, emits `recording:state`/`recording:settings`
directly to WebView windows, and relays state/action events to Electron for the
existing desktop toast lifecycle. In normal non-mock Tauri runs, Rust owns the
recording status-pill window, its persisted preference, readiness replay and
nonblocking latest-state reconciliation. Mock Tauri and standalone Electron
keep their existing pill owner. The native lifecycle has focused fake tests;
its rendered placement and behavior still require a desktop pass. Native recording
playback owns `recording-clips-list`, `recording-clip-url`,
`recording-clip-delete`, the `arc-power-media` range protocol, and cached
FFmpeg thumbnails. Clip paths are revalidated through the native recording
store and recording root on every request; the protocol body is capped at
4 MiB and advertises `Content-Range`/`Accept-Ranges`. The actual HTML5 video
element remains in the renderer. Screenshot capture is native: display capture
uses GDI BitBlt, window capture uses PrintWindow with a window-DC fallback, and
the bundled FFmpeg writes the PNG. The recording hotkey no longer relays
through Electron.

Native `startup-get`/`startup-set` own startup registration. Dev builds use the
HKCU Run value; packaged builds verify, create, or remove the elevated
`ArcPowerStartup` logon task and clean legacy Run/task entries. The public
`startWithWindows`/`applyOnBoot` state is composed from the verified
registration and the persisted native settings.

Native fan-resume (`fan_resume.rs`) owns `fan-resume:get`/`fan-resume:set`,
power suspend/resume handling, saved physical-GPU proof matching, and the
read-back-verified native fan apply after sleep. Records stay in the native
`FanResume.json` store. The Electron controller is only the mock/unelevated
fallback.

The native RTSS OSD publisher (`rtss_osd.rs`) owns the `RTSSSharedMemoryV2`
slot, Classic text/color/position tags, foreground RTSS FPS/frametime and API
rows, the embedded frametime graph, RTSS percentile rows, overlay
visibility/toggle, and the `overlay:get-state`/`overlay:toggle` channels when
the RTSS renderer is selected. Electron's publisher is created with
`sharedMemory:false` in normal Tauri runs so it cannot clear the native slot.

Native RTSS startup registration (`rtss_startup.rs`) owns the independent
`ArcPowerRTSS` HKCU Run value and the persisted `rtssOnBoot` intent. Native RTSS
profile/frame-limit control (`rtss_profile.rs`) loads `RTSSHooks64.dll` and owns
the Vector2D OSD profile setup, global and per-game frame limits, ownership
snapshots, restore tokens, conditional expected-state checks, shared limiter
flag handling, and read-back-verified rollback. In normal Tauri runs Electron
routes `rtssFrameLimiter` to those native methods; the helper child remains the
non-Tauri fallback. The controller rejects externally edited profiles instead
of overwriting them and never deletes a profile it cannot prove it created.

Native game discovery (`game_scan.rs`) owns `games-scan`: bounded uninstall
registry, Start Menu shortcut and running-process enumeration; the shared
game-candidate gate; shell icon extraction to a PNG data URL; and local
poster/Steam-cache banner resolution. The resulting apps sync through the
native game catalog with authoritative replacement. The scan is read-only and
never executes or launches a discovered path. `game-catalog-sync`,
`game-profile-save` and `game-profile-delete` also run natively against the same
catalog/association store. A live read-only comparison on this host returned
the same three apps and executable paths as the Electron scanner;
artwork/banner cache parity still needs a desktop visual pass.

`game-profile-capabilities` is native too: it reads
`ctlGetSupported3DCapabilities` through the same installed IGCL package, applies
the integrated/mobile platform gate, the XeFG executable classifier and the
sharpening integer-range contract. The live B580 read matched Electron exactly
(Endurance off, XeFG available for Cyberpunk 2077, sharpening unavailable).
`game-settings-save` and `game-settings-delete` are native too. The save path
merges the per-GPU patch, gates XeFG through the native capability read, applies
the driver scope and each supplied 3D feature with read-back verification, uses
the native RTSS controller for frame limits, and persists/rolls back through the
native game store. Delete clears driver scope per resolved physical target,
removes the RTSS profile, deletes the sidecar record and compensates runtime
state on failure. The write layer is fake-driver tested and passed an approved live low-risk
save/delete on Punishing: Gray Raven (`lowLatency: off`) with scope and
read-back verification, then a verified delete and sidecar cleanup. Broader
per-game controls, frame limits and rollback-under-failure still need matched
live coverage.

Overlay layout listing, save, select, delete and rename remain broker-dispatched
so one settings/layout queue owns their order. Listing uses a native snapshot
that reads the sidecar and current settings defaults under the shared layout
and settings locks. In normal Tauri runs, mutations use one private native-store
transaction that updates the sidecar and selected settings under those same
  locks, then returns layout data and the committed settings cache. The broker
  updates its synchronous cache from mutation replies and list snapshots inside
  the same dispatcher queue, before refreshing the software HUD, RTSS OSD and
  advanced overlay; rename does not trigger an unnecessary settings apply.
  Saves pass through the established JavaScript layout normalizer, including
  coercion of special values, before entering that combined transaction. A
  normalized NaN opacity remains JSON null in the sidecar so later loads inherit
  their current defaults, while the save response restores the legacy transient
  NaN value; explicit null has already inherited its fallback.
  The adapter never writes a separate JS sidecar. Mock and
standalone Electron retain their existing path. Tests cover the combined store
result, cache-before-refresh order, exotic input normalization, atomic list
ordering, existing layout serialization, and concurrent Rust layout/settings
transactions. The live WebView2 layout pass remains a desktop gate.

Tauri window restoration and persistence use the native window-state
serializer. Electron discovers current display work areas and passes them to
Rust for restore; window events pass raw normal bounds and maximize state for
Rust to serialize and persist. A missing state returns null so the existing
centered default-size path applies. Standalone Electron retains JavaScript
restore/save; mock runs skip window-state restoration and persistence under
the existing startup guard.

Native profile management (`profile_write.rs` / `profile_transfer.rs`) owns
`profiles-save`, `profiles-delete`, `profiles-export` and `profiles-import` in
normal Tauri runs: the 15-control settings sanitizer, profile/id/name identity
validation, the versioned path-free transfer envelope, import planning
(per-device scoping, case-insensitive name-collision suffixes, schema-version
skips, warnings), and the profiles→settings→recording commit with best-effort
compensating rollback that rethrows the original error. Mock sessions delegate
all four channels to Electron.

`profiles-settings-save` is native for Phase 2 (`settings_patch.rs`): 12 of the
35 patch keys are native and the other 23 delegate. Native keys are
`startWithWindows`, `ocOnBoot`, `activeProfileId`, `activeProfileIds`, `theme`,
`monitorLogToFile`, `monitorLogMetrics`, `arcSleep`, `startMinimized`,
`closeToTray`, `recordingToastsEnabled` and `overlayRecordingPill`. Delegated
keys are `rtssOnBoot`; the 17 remaining `overlay*` keys (`overlayEnabled`,
`overlayHotkeyLetter`, `overlayPosition`, `overlayRenderer`, `overlayScale`,
`overlayColor`, `overlayLabelColor`, `overlayValueColor`,
`overlayTemperatureUnit`, `overlayStats`, `overlayDeviceKeys`,
`overlayBgEnabled`, `overlayBgColor`, `overlayBgOpacity`, `overlayChipNames`,
`overlayPollMs`, `overlayTheme`); `postprocessScaleHotkey`,
`memorySavingMode`, `advancedOverlayEnabled`,
`advancedOverlayHotkeyLetter` and `advancedOverlayPosition`. Any patch
containing a delegated or unknown key delegates WHOLE before the store is read
or written. A frame the tagged codec rejects, and a value it cannot reduce to
ordinary JSON, also delegates because JavaScript owns their coercion; a
non-object payload is rejected natively with the handler's
`profiles-settings-save: patch must be an object`. Mock sessions delegate the
channel.

After a successful non-mock native save, the host sends a best-effort
`settings-cache` host event to target `main` with `{settings: …}` containing
the WHOLE settings snapshot (not a diff). The broker allowlists the event; the
compatibility service passes a valid snapshot to
`NativeProfileStore.acceptSettingsSnapshot` to replace `_settingsCache`. This
keeps cache-backed close-to-tray, toast and compatibility-pill readers current;
without a fresh `closeToTray` cache, window close can quit instead of hiding to
the tray. `startMinimized` has no save-time side effect: its consumer reads
settings fresh at boot. The four promoted boolean keys use patch-aware
`=== true` coercion in `next`; if a key is absent, its stored value is retained.

The reply remains the handler's `next` envelope, never the normalized store
cache: the two intentionally differ (`memorySavingMode` inheritance, the
`recordingToastsEnabled` rebuild, an unvalidated `activeProfileId`), and the
renderer replays `next` into its own view, so the native envelope keeps
Electron's keys and key order.

The save derives `wanted = startWithWindows || (ocOnBoot && hasActiveProfile)`
from the merged intent, proving an active profile through the per-device
`activeProfileIds` map against the loaded profiles or the legacy scalar
`activeProfileId`. It writes the startup registration BEFORE the settings
write, persists through `save_settings_with_arc_sleep` when the patch carried
`arcSleep` (so the native Arc Sleep controller adopts the policy on its next
cadence), then answers `next`. A packaged startup-registration failure still
persists settings but returns an error and therefore does not push a snapshot.
The registration write remains injected in tests; a live Run-key/logon-task
write is still gated.

The implementation is fake/fixture tested only: 891 tests are reported green,
including a regenerated 253-case differential against the real Electron
handler. Service-mode tests cover cache replacement, malformed-payload
inertness and unknown-event session closure. The host push is fire-and-forget:
a dropped push leaves `_settingsCache` one save stale until Electron's next
`loadSettings()`. Delegated Electron saves and native pushes can interleave with
no cross-host serialization or reply/push ordering guarantee. A native save
also skips the renderer broadcast of `overlayRecordingPill` and
`recordingToastsEnabled` to the advanced-overlay window, so its quick controls
can remain stale until re-render. Close-to-tray behavior itself remains a
desktop gate.

Native driver management (`driver_monitor.rs`, `intel_driver_catalog.rs`,
`intel_driver_download.rs`) owns all twelve driver channels and the
`intel-driver-download:progress` event in normal Tauri runs: the registry driver
date, the `driver-observations.json` transition sidecar, Intel catalog/release
metadata with fixed-page allowlists and bounded caching, validated
download-page opening, hash/size/`MZ`-verified streaming downloads with
cancel/delete and per-kind locks, native maintenance quiesce, and the detached
installer handoff with whole-app exit. The page allowlists are not
`www.intel.com`-only: catalog fetches accept the eight fixed roots under
`www.intel.com` (us/en) and `www.intel.cn` (cn/zh), matched on host and path
identity with no port, userinfo, query or fragment (`has_safe_page_authority` /
`same_page_identity` in `intel_driver_catalog.rs`), and release pages are those
roots or the `/content/www/<us/en|cn/zh>/download/<id>/<detail>/<slug>.html`
detail pages carrying a root's own host, locale, id and slug
(`valid_intel_driver_release_url`). Catalog refresh tries the us/en root
first and falls back to the cn/zh root per kind (`page_candidates`), and a
release-page fetch may only redirect within the host it started on
(`valid_www_intel_url` in `intel_driver_download.rs`). Installer
downloads do not accept cn: the URL must be `downloadmirror.intel.com` with a
`/<id>/gfx_win_101.<n>.exe` path (`valid_mirror_url`), so a cn-hosted installer
link is rejected. In the native Tauri service path, a no-version
`intel-driver-download-page-open` targets the us/en official page:
`official_download_page` returns `pages(kind).official` — the
`www.intel.com/content/www/us/en/` root, matching Electron's
`INTEL_DRIVER_PAGES[kind].officialPageUrl` — and `services.rs` calls it when the
request carries no version. The target is locale-independent by decision, not by
accident: Intel has no separate EU Arc page and serves Europe from the us/en
path, so one us/en default covers both North America and the EU without
inspecting the user's locale, and no locale question is left open. cn/zh is now
a fetch and fallback source rather than the page-open default: the eight fixed
landing pages in both locales are still accepted for catalog and release-page
fetches (`is_fixed_official_page`, `valid_intel_driver_release_url`), a validated
open still accepts them, and catalog refresh still tries the us/en root first and
falls back to the cn/zh root per kind (`page_candidates`). A versioned open uses
that release's own `officialPageUrl`, which may be either locale. The channel
sits behind `!context.mock_mode`, so a mock session delegates it to Electron,
which opens the same us/en page (`INTEL_DRIVER_PAGES[kind].officialPageUrl` in
`ipc-core.js`); on this default the two hosts agree. The change has landed in
the native source and is in review for release, so this is the native source's
behaviour rather than a shipped build's. The live-Intel caveat is unchanged:
downloads and installs are fixture/seam tested, and a live Intel download and
interactive driver installation have not been run. The installer is spawned with
CreateProcess semantics only (no `runas`); an unelevated host preserves the
existing 740 failure. Mock sessions delegate every driver channel to Electron.

Native device selection (`device_selection.rs`) owns
`device-selection-request`, `device-selection-generation-get`,
`device-selection-push`, `device-preferred-get` and `device-set` in normal
Tauri runs. It preserves the process-lifetime generation handshake, role-targeted
`request`/`updated` events, lossless tagged-wire `caps`/`state` relay, ambiguous
identity refusal, native settings persistence and QueryDisplayConfig
active-display proof for preferred-device selection. It delegates when the
native inventory is empty/unavailable or display proof cannot be produced.
Mock sessions stay on Electron; live multi-GPU switching remains a desktop gate.

The LibreHardwareMonitor bridge and payload mapper are native in
`lhm_bridge.rs`. Native telemetry lanes in `telemetry.rs` own
`telemetry-start`, `telemetry-stop`, `telemetry-latest` and
`overlay-telemetry-start`, emit `telemetry:sample` directly to WebView windows,
and feed the native RTSS OSD publisher directly. Electron's telemetry lanes
and shared-memory RTSS publisher are disabled in normal Tauri runs. Windows
D3DKMT node utilization
is native (`d3dkmt_util.rs`) and overrides the LHM GPU Core fallback when a
fresh per-LUID sample exists; the PDH GPU Engine fallback is native in
`pdh_gpu_engine.rs`. Native NVML/ADL sampling (`vendor_telemetry.rs`) covers the
no-device/fallback lane and `vendor-info:get` returns NVML VRAM/cores plus the
published AMD Compute Unit table. Native `list-devices` merges IGCL rows with
read-only SetupAPI/registry OS display adapters; Intel rows keep their existing
ids and OS rows are appended. NVML/ADL select the provider instance by the
target BDF, so secondary non-Intel overlay lanes resolve OS-only ids. A
multi-adapter vendor target with no BDF match fails closed instead of borrowing
another adapter's sample. The LHM/D3DKMT/PDH/vendor mapping and Rust lane
sampling are fixture-tested. In the native LHM lane, `memoryUsedBytes` keeps
Electron's hybrid precedence: a non-null LHM memory sensor wins, otherwise
Windows `GlobalMemoryStatusEx` supplies total physical bytes minus available
physical bytes; if both sources fail the sample contains `null`. If native LHM
is unavailable, telemetry still defers to Electron. The null-device request
can also run natively when LHM is available; that lane merges vendor readings
under their `gpu*` fields while keeping `memoryUsedBytes` on the LHM/system
memory source. Electron's separate non-LHM null-device fallback retains its
legacy `gpuMemUsedBytes ?? extra.memoryUsedBytes` composition; this slice does
not change or claim parity for that path. A focused fake-only Rust test covers
the LHM/system-memory precedence and failure shape; no live LHM/RTSS/WebView
telemetry session has been run.

Native Stability Lab runs (`stability_runtime.rs`, `stability_workload.rs`,
`stability_whea.rs`) own `stability-run-start`, `stability-run-status`,
`stability-run-cancel` and the main-window-only `stability:status` push in normal
Tauri runs. A run is bound to exactly one durable device key, re-resolved each
tick, and samples the native telemetry lane plus RTSS foreground FPS/API data.
It normalizes samples through the shared stability contract, tracks freshness,
threshold/driver/WHEA counters plus the latest observed value and limit for each
breached metric, and appends the terminal report through the native stability
store. Power thresholds use the Tuning PL1 source (`power-limits:read` sustained
watts where that readout is used, or the current driver setting converted to
Tuning's displayed watts for Battlemage percent controls; B580 100% reads as
217 W). Temperature uses the driver temperature limit in displayed Celsius.
If a device value is unavailable, the report records a 200 W / 85 °C fallback
in `thresholdLimits`, `thresholdSources`, `thresholdFallback` and
`thresholdFallbacks`. The temperature abort remains an independent hard 90 °C
guard. The run status exposes
D3D11 submit/error/thread-finished diagnostics and
emits one `[stability]` summary line when a run ends. Normal `"completed"`
statuses are rendered from the report classification and breach count rather
than being treated as an unavailable outcome. The stability sampler reads the
main telemetry lane keyed by the selected native device ID and rejects a
sample whose reported device key does not match the selected key or its aliases.
The bounded D3D11 workload matches the Koffi reference:
64 resident 3072x3072 R8G8B8A8 render targets, 1024 copies, 64 draw passes and
8 clears per 2 ms tick, event-query fencing, and no per-tick CPU upload. The
WHEA monitor runs the same PowerShell `Get-WinEvent` query on a one-second poll
and degrades to unavailable on failure. Adapter selection, request clamps,
status/cancel semantics, one-active-run behavior, durable-key re-resolution,
classification/evidence, report append and cleanup order are seam-tested with
fake workload/WHEA/telemetry; a live D3D11 stress run and live WHEA Event Log
query remain desktop gates. Mock sessions delegate all three channels to
Electron.

The native host now owns the tray icon/menu (including the recording/replay/
saving/error badge and tooltip), suspend/resume notifications, the overlay,
advanced-overlay and postprocess-scale global shortcuts, and the recording
toggle/save/screenshot hotkeys. The tray toggle, quit and "Apply active profile"
are native; shortcut effects are relayed to the compatibility service. A tray
apply plans every active physical-GPU profile before any setter: if any entry
cannot be proved natively, the whole action is relayed to the broker so no GPU
is applied twice. Temperatures at boot still require the Electron broker, which
is already running by then.
The native host shell registers overlay shortcuts from the persisted settings
and refreshes them on a two-second cadence; recording hotkeys reload
immediately after a recording-settings save and report registration conflicts.
A live launch verified the host stays running, owns `Ctrl+O`, and owned `F9`
for native recording.

Native Advanced Overlay (`advanced_overlay.rs`) owns
`advanced-overlay:get-state`, `advanced-overlay:toggle`,
`advanced-overlay:close` and the panel-only `advanced-overlay:settings` push in
normal Tauri runs. The panel uses the existing auxiliary role rules
(`advanced-overlay-<generation>`), fixed 360x616 DIP geometry anchored to a
primary-display edge, and is created hidden and destroyed on a deferred session
hide/close. The persisted `advancedOverlayEnabled` master remains Electron-owned
through `profiles-settings-save`; a two-second native settings poll plus the
panel-load push forward position/theme/stats. The host `RegisterHotKey` snapshot
now reports the advanced hotkey's actual registration, and the native shortcut
action calls the native toggle. Mock runs still delegate all three channels to
Electron. State, geometry, settings-event targeting and the fake window/hotkey
seams are Rust-tested; a live WebView2 panel toggle has not been run.

Native screen post-processing (`postprocess_sharpening.rs`) owns
`postprocess-sharpening:get/set/select-window/stop-window/hotkey-get/hotkey-set`
and `arc-super-resolution:get/set` in normal Tauri runs. It persists
`{global, games, asr, asrGames}` at `%APPDATA%\ArcPower\postprocess-sharpening.json`
(unknown top-level keys fail closed without rewriting the file), keeps the
read-only `reshade-managed-games.json` audit fields, resolves and SHA-256-pins
the existing Electron helper, and drives the one-window `SCALE`/`STOP` protocol
with a five-second selection countdown and a two-second kill fallback. Status
and global-settings revision events are pushed to the main window only. The
`postprocess-scale` shortcut is consumed natively; the host shell publishes its
`RegisterHotKey` snapshot so `hotkey-set` can report confirmed registration.
Mock runs still delegate these channels to Electron. The helper process and
capture path are seam-tested with a fake child; a live capture session has not
been run.

The bundled 2023 IGCL runtime's V1 power/temperature setters and delayed
read-back rules are ported in `legacy_igcl.rs` and mock-tested. Level Zero
Sysman power-pair and voltage-target read/write are ported in
`sysman.rs`/`sysman_power.rs`/`sysman_voltage.rs` with BDF-matched devices and
mock-tested policy. The Alchemist voltage sequence is wired but not yet
live-verified on A770/A750 hardware.

VF writes are live-verified: one reversible frequency edit was applied on the
B580, the driver returned a normalized curve, and the original curve and both
core offsets were restored and verified. Fan apply reuses the table/fixed/default
setters already exercised by the approved reversible fan probe.

Durable settings remain in `%APPDATA%\ArcPower` through the existing stores and
migrations. WebView2 browser data uses `%APPDATA%\ArcPowerTauriCache`, separate
from the Electron cache. The Electron-origin localStorage sidebar-width value
does not automatically transfer to WebView2. A one-time preference import is
needed to preserve its previous width. The
native maintenance path clears only its fixed browser cache before constructing
WebView2, with reparse-point and containment checks; the existing backend remains
responsible for durable reset confirmation and its own cache.

Mock launches create a shared private `ArcPower-Tauri-Mock-*` directory under
the temporary directory. Both runtimes use that directory for browser and
application data, and the broker isolates its known document/media paths there.

Normal non-mock Tauri runs handle `registry-catalog` in Rust using the shared
`src/main/registry-catalog.json` descriptors and fixed read-only `reg query`
commands. Missing values, access failures and timeouts follow the existing
parser semantics: a failure with no parseable output degrades to the default
state, while captured stdout is still interpreted on timeout or output limits.
The private `registry-apply-plan` operation also selects the ordered action
descriptors from that embedded shared catalog. Every non-mock Tauri apply uses
the strict Rust helper: an already-elevated host directly spawns the same
executable, while an unelevated host uses `ShellExecuteExW` with `runas`. The
helper executes only the fixed-catalog `REG_DWORD` add/delete operations with
`winreg`; it does not launch `reg.exe` for writes. Both launch modes use the
same one-use pipe
whose DACL grants the launching user, built-in Administrators and SYSTEM, and
rejects remote clients. It verifies the parent/server PID, executable identity
and elevated token, then independently resolves the embedded catalog plan.
Before connecting, the helper opens and holds the parent process and its
primary token; after the pipe authenticates that PID, it checks the same held
process is still live and derives `TokenUser` from its token. The SID is never
accepted from IPC. A pure plan check requests the parent hive only for actions
with current-user writes. Before any step of such an action, including the
first HKLM step of the mixed MPO plan, the helper opens and holds the exact
existing `HKEY_USERS\\<parent-SID>` root with the required write/subkey rights.
It keeps the parent and token handles, and when needed the hive handle, open
through result delivery. This preserves the launching user's HKCU intent when
UAC credentials belong to another admin account: embedded `HKCU\\...` and
`HKEY_CURRENT_USER\\...` paths resolve relative to that held user hive, while
result labels retain the catalog's original paths. Machine-only HAGS and Game
DVR actions do not require access to the user's hive. Explicit `HKU`,
`HKEY_USERS`, `HKCR`, `HKEY_CLASSES_ROOT`, `HKCC` and
`HKEY_CURRENT_CONFIG` plan roots fail closed, as do invalid SIDs or an
unloaded/inaccessible hive required by the plan. Pipe access alone does not
authorize a client: acceptance requires the exact launched helper PID.
The helper accepts only an entry ID and action, uses no shell, validates every
step before writing, and checks its parent lease before each write. It opens
the exact existing `HKEY_USERS\\<parent-SID>` root with the required
subkey/value rights for current-user plans and holds it through the apply;
write operations use only relative paths below that handle. A global named
mutex serializes native applies across Tauri processes. If its previous owner
abandoned the mutex, the
helper reports an indeterminate prior result and performs no step. The pipe
closes on timeout, and a retained helper-process handle fence prevents another
apply in the same host from overlapping a native call that is still finishing.
An elevation/helper startup timeout before request delivery reports every
step as `not-run`; UAC decline remains a separate cancellation result. If the
request may have been delivered but the helper response is lost, every step is
reported as `unknown` with an indeterminate outcome. That result advises
waiting for the helper and refreshing before retry or revert. No helper launch
or transport failure falls back to Electron. Standalone Electron
and mock apply behavior remain unchanged; mock catalog reads and applies stay
in Electron so they share mutable state. Standalone Electron does not yet use
the native apply mutex. The host builds and focused fake and private-pipe tests
pass; the helper has not been runtime-verified with UAC, alternate credentials
or registry operations.

Normal non-mock Tauri runs own the update flow natively. The native host
fetches the GitHub `releases/latest` metadata over HTTPS, selects the asset
with the pure Rust selector (`update_release.rs`: tag, matching asset
URL/name, size and SHA-256 digest), streams the verified download with
progress events, and issues an opaque one-use receipt token before the
install handoff (`update_hub.rs`: an installed build re-runs the wrapper
with `--update --update-parent-pid <pid> --update-install-dir <dir>`, a
portable build hands off with `--portable-update`, then the host exits). The
splash update decision and its timeout belong to the native
`startup_update.rs` coordinator, and the renderer receives only the selected
asset fields and the receipt token. Electron's update channels still enter
through `ipc-core.js`, but in a normal Tauri run the check, download and
install are dispatched to the native host over the private pipe
(`update-check`/`update-download`/`update-install` native-store requests; a
startup-intent check answers from the cached splash decision, and the
download request carries the long timeout). Standalone Electron and mock
runs retain the JavaScript `auto-update.js` path, and a standalone check may
still use the same pure selector through `update-release-select`. These
native paths are not live-verified: no GitHub check/download/install round
trip is recorded, and the release doc's installed `--update` acceptance
remains open.

The normal Tauri application path uses Rust for OBS WebSocket control and its
DPAPI credential store, recording-folder and game-executable pickers, CF_HDROP
file and text clipboard writes, recording display/window screenshots, and game
discovery icon extraction. The compatibility adapter can import an existing
OBS password once from Electron `safeStorage`; standalone Electron retains its
own `safeStorage` fallback. Setup, removal and the installed-update payload
replacement run natively before WebView startup (`native_installer.rs`,
`runtime.rs`); standalone Electron retains its own installer UI path.

Production elevation and scheduled-task/relaunch executable identity must be
verified against the final packaged host. An elevated installer alone does not
prove the host or child service has the required token. Portable and installer
packaging must also handle WebView2 availability and carry the existing native
helpers and recording resources. Existing Electron update assets cannot be
assumed to update a future Tauri distribution correctly.

The existing Electron `ui-verify.js` depends on Electron DOM execution and
capture APIs. A WebView2 runtime verification path is required; passing Electron
UI tests alone does not verify this new main frontend.
