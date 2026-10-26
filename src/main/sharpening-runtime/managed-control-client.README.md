# Managed sharpening control client

This is Arc Power's private native shader-control client. Game launch is owned
by the separate normal-user launcher. The bridge communicates only with the
fixed per-process named pipe `\\.\pipe\ArcPower.ManagedSharpening.v1.<PID>`.

Build with `build-managed-control-client.ps1`. The executable is written under
the ignored `.codex/task-artifacts/managed-control-bridge/` directory. Use
`-UpdateBundled` deliberately to replace the bundled executable, then update
its integrity pin in `managed-sharpening-runtime.js` after validation.

Run `managed-control-client.exe --serve` to read bounded ASCII commands from
stdin. Each line is at most 256 bytes and has exactly one of these forms:

```
QUERY <request-id> <pid> <creation-filetime>
SET <request-id> <pid> <creation-filetime> <revision> <enabled-0-or-1> <percent-0-to-100>
```

All numeric values are unsigned decimal integers. `creation-filetime` is the
process creation `FILETIME` as an unsigned 64-bit integer. The client verifies
that the target process handle still refers to that PID and creation time, and
that the process shares the caller's Windows session and user SID. It checks
the named-pipe server PID before sending the protocol request. Pipe I/O is
overlapped with a two-second operation deadline. If an operation times out,
the client requests cancellation and waits for that local named-pipe operation
to reach terminal completion before releasing its `OVERLAPPED`, event, or data
buffer. That cancellation drain may extend wall-clock return time; the caller
should also enforce its own process-level timeout.

One stdout response is emitted for each input line. Successful transactions
use `RESULT <request-id> <status> <accepted-revision> <applied-revision>`;
malformed input returns `ERROR <request-id-or-0> malformed` and a failed pipe
or identity check returns `ERROR <request-id> pipe_or_identity`. Diagnostics
go to stderr. Input is parsed as bounded bytes; NUL, non-ASCII, oversized,
empty, overflowed, or extra-token lines are rejected, and oversized input is
drained through its newline. `--help` prints usage and exits without contacting
a process.

The private binary request/reply/acknowledgment structures match
`managed_sharpening_control.hpp`; this client does not load a DLL or access an
arbitrary path or command.
