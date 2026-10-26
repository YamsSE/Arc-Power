# Sysman crash and retry investigation

## Supplied evidence

The October 24 investigation used the supplied `arcpower-sysman-helper(2).log`
and `arcpower-sysman-debug(2).log`. Their contents span several days. Current-day
analysis uses the Europe/Berlin October 24 window, beginning October 23 at
22:00 UTC; file modification time is not the time of the last recorded event.

The files contain 418 failed initialization attempts that intended to exit 77:
13 on October 17, one on October 18, 14 on October 19, 17 on October 20, and 373
on October 21. October 21's median interval between these exits is 18.46 seconds.
Every failed-init exit reaches the JavaScript exit-handler marker before the
parent observes `0xC0000409`. This locates the recorded crash after that marker;
it does not identify the native teardown component responsible.

## Current-day distinction

The current-day runs initialize standalone Sysman successfully using
`C:\Windows\System32\ze_loader.dll`. Three tracked native crashes follow
explicit shutdown sequences from helpers that intended to exit zero. One of
those helpers had been ready for about 12 hours and 51 minutes before shutdown.

The latest captured helper, PID 27984, becomes ready at October 24 11:44:27.949
UTC and handles successful requests through 11:57:12.025 UTC. The supplied logs
contain no exit for that helper and end at that time. Thus these files do not
show an ongoing failed-init restart storm in the latest captured session.

The separate report of 630 approximately 15.7 MiB blocks is not an allocation
trace in these logs. These files contain 418 failed-init attempts and do not
identify the owner or lifetime of the reported blocks. Memory in a terminated
child must not be assumed to remain in its parent. The separately reproduced
native scratch-buffer leak is documented in
`native-polling-memory-2026-10-24.md`.

## Preventive recovery change

The proxy now stops automatic recovery for the app session after three distinct
abnormal child failures within five minutes. It counts failures across ready
signals, deduplicates a child's error/exit events, cancels pending heal timers,
and checks again at the spawn boundary after asynchronous connection attempts.
An already-connected helper is left intact. Expected exit 77, clean bind-race
exit zero, and intentional shutdown do not count toward this breaker.

The existing fast/slow recovery cadence counter still resets on readiness;
the separate rolling abnormal-failure history does not. Restarting Arc Power
creates a fresh session. The recovery stop reason is logged.

## Shutdown drain

An explicit shutdown now stops accepting connections immediately and rejects
connections raced after that transition. It discards queued work, waits for
initialization and any active consumer request plus its response write, then
writes the shutdown acknowledgement and closes the remaining owned sockets.
Queued callers therefore observe disconnect rather than waiting on an ignored
request. The idle timer cannot bypass this drain.

An in-flight native operation is deliberately not terminated on a timer. If it
never completes, draining can remain pending, although the listener has already
closed. No forced process termination or DLL-detach bypass was introduced.

Focused recovery, initialization, shutdown-drain and process-identity tests pass
24 cases; type checking passes. These are preventive lifecycle changes, not a
claim that the native teardown crash or reported 9.66 GiB allocation retention
has been fixed. No hardware writes were replayed from the supplied logs.
