# Native polling memory investigation

## Report and evidence boundary

A user reported approximately 2 GB of memory after two hours in the portable
built for the A770 Sysman initialization fix. The page, process, and measurement
were not supplied. The issue may predate that build.

This investigation found concrete native allocation leaks. It has not reproduced
the reporter's exact two-hour run or established that these allocations explain
all of the reported memory.

## Process inspection

The installed Koffi 2.16.3 implementation (`CallAlloc` in `ffi.cc`) allocates
with `calloc` and returns a native external without a freeing finalizer.
`koffi.free` is a separate explicit operation. Dropping the JavaScript pointer
does not release the allocation.

The RTSS process inspector previously allocated one unmanaged PROCESSENTRY32W
buffer per process-list iteration, including the end-of-list probe. The x64
buffer is 568 bytes. RTSS image-path queries also allocated a 65,536-byte string
buffer and a four-byte length buffer without freeing them.

`getRuntime()` currently makes two process inspections: one during path lookup
and one for the current running state. Actual call frequency depends on active
consumers. For illustration, 300 processes, two snapshots per second, and two
hours imply roughly 2.45 GB of entry allocations alone. This is conditional
allocation arithmetic, not measured private bytes or an established polling
rate for the reporter.

Foreground game inspection had the same lifetime mistake in synchronous process
path, module enumeration, window PID, and process snapshot scratch buffers.
Its snapshot entry is reused within a scan, so it has no per-process allocation
multiplier. Large path/module buffers can nevertheless accumulate across scans.

Regular IGCL raw telemetry and temperature-sensor fallback reads, and the CPU
`GetSystemTimes` reader, also allocated unmanaged scratch buffers per read.
Those specific synchronous outputs now use Node buffers with the same byte
sizes and zero initialization. IGCL V2-to-V1 fallback and structure headers,
sensor selection, and the CPU FILETIME offsets are unchanged. This is a bounded
hot-path fix; other native allocations in the backend have not been audited or
converted by this change.

The corrected adapters use garbage-collected Node buffers for these synchronous
scratch outputs. Native process/snapshot handles retain their existing explicit
close paths. No pointer is intentionally retained by these native APIs after
the synchronous call returns.

## Validation

The focused process-inspection regression covers 1,000 snapshots of 300 fake
processes, repeated image-path queries, and failure cleanup. It checks that the
native adapter receives Node buffers rather than unmanaged allocations.
The RTSS startup suite passed 30 tests after this change.
An additional 17 focused telemetry/CPU tests passed, covering repeated reads,
native failures, fallback, sizes, and pointer offsets. Independent source reviews
found no material issues in either bounded change. The combined focused run,
including the 11 managed-control tests, passed 58 tests; type checking passed.

An isolated Windows Node process also exercised the real Toolhelp process
enumeration and own-process image-path APIs, with forced GC between five batches
of 100 scans. The prior implementation from feature HEAD grew from 47,951,872
to 161,697,792 RSS bytes across 500 scans (127,000 process entries). The corrected
implementation grew from 47,194,112 to 54,030,336 RSS bytes, with post-warm-up
batches remaining around 53–54 MB (125,000 entries). JavaScript heap and reported
external memory were approximately flat in both runs. Background process counts
varied slightly between the sequential runs. Both test processes exited.

This is a real native-call reproduction of the specific allocation leak and
evidence that the corrected scratch storage is reclaimed. It uses accelerated
scans and forced GC in a separate Node process, not normal Electron GC timing.
The diagnostic source and results are retained under
`.codex/task-artifacts/native-memory-proof/`.

These checks establish the allocation ownership change and preserve tested
behavior. They do not establish a two-hour memory plateau in the packaged app.
GPU-process caches, renderer memory, other native API allocations, and driver
allocations remain separate possible contributors.

A separate own-process `VirtualQuery` probe compared committed private regions
during another 500-scan run. RSS grew from approximately 59.4 to 171.8 MB with
the prior implementation, versus 59.3 to 62.7 MB with the correction. Neither
run reproduced the reported repeated 15.7 MiB region shape. This strengthens
the specific scratch-buffer leak reproduction but does not identify the owner
of those reported blocks. The region metadata and probe are retained under
`.codex/task-artifacts/native-memory-proof/region-shape/`.
