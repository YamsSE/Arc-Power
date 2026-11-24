# Temperature-ceiling refusal cache contract (Phase 1)

## Status and scope

This document freezes the approved cross-host contract. Phase 1 is contract
documentation and shared differential fixtures only: Electron remains the
temperature-apply/cache authority, and Rust's staged preflight remains
unconnected to service routing. The fixtures are not evidence of live hardware
behavior.

The cache is session-scoped and volatile. It is owned by the compatibility
broker process, is never persisted, and is cleared when that broker process
restarts. Driver-version changes do not invalidate it. Rust may keep a
validated mirror for decisions inside an already-authorized native transaction,
but that mirror cannot create, clear, or override the broker's cache state.

## Transaction ownership and ordering

Every broker apply whose payload may contain `tempLimitC` is one broker-FIFO
transaction:

1. Acquire the existing broker apply FIFO.
2. Allocate the broker `epoch`/`transactionSequence`, resolve the target, and
   read fresh capabilities/ranges and the current cache snapshot.
3. If the transaction is eligible for a native preflight/setter, perform the
   preflight and any required setters. For an actual setter, capture the exact
   finite temperature value passed to it; do not substitute the renderer's
   original request or a later read-back.
4. Publish the outcome and resulting cache snapshot (or publish unavailable/
   poison state) before the FIFO is released.
5. Release the FIFO.

Lock order is **broker FIFO first, then
`Local\\ArcPower-GPU-Apply-v1` only around the setter**. The GPU mutex is not
held while acquiring/waiting for the broker FIFO, reading cache/capability
snapshots, or publishing the outcome. This keeps the parent/worker handoff from
waiting on a GPU mutex held by another transaction.

`transactionSequence` is a positive, strictly increasing integer assigned by
the broker while it owns the FIFO. It orders temperature-eligible transactions
within one `epoch`. `cacheGeneration` is a separate nonnegative monotonically
increasing integer: it changes when the authoritative cache contents or
availability state changes, not merely because a read occurred. Rust accepts
only a snapshot whose epoch, sequence, target and generation are validated
against the current transaction; an old snapshot is never interpreted as a
cache miss.

## Wire messages

These are logical message shapes over the existing authenticated tagged wire
codec, not JSON transport. The codec must continue preserving `undefined` and
non-finite numeric values; do not JSON-round-trip these messages. In particular,
`cache.ceilings.tempLimitC` is explicitly `undefined` when an available cache
has no learned temperature ceiling. It is not interchangeable with `null` or
with a missing cache snapshot.

### Begin snapshot

The broker creates this snapshot after taking the FIFO and doing a fresh
capability read. Rust may validate/mirror it but does not become cache
authority:

```js
{
  type: "temperature-refusal-cache:begin",
  schemaVersion: 1,
  epoch: "<opaque broker-process session id>",
  transactionSequence: 42,
  cacheGeneration: 7,
  target: {
    electronOrdinal: 0,              // routing hint only; never a cache key
    deviceKey: "pci:0x00008086:0x0000e20b@3:0.0",
    pciVendorId: "0x00008086",
    pciDeviceId: "0x0000e20b",
    bdf: { bus: 3, device: 0, function: 0 },
    luid: "0x00000001:0x00000002"    // when supplied by the fresh row
  },
  ranges: {
    tempLimitC: { units: "C", min: 50, max: 115, step: 1 }
  },
  requestedSettings: { tempLimitC: 105 },
  cache: {
    status: "available",             // "available" | "unavailable"
    ceilings: { tempLimitC: undefined }
  }
}
```

`requestedSettings` is the request entering this transaction, not proof of what
was passed to a setter. `ranges` and `target` must come from the fresh,
versioned broker preflight belonging to this transaction. A snapshot with
`cache.status: "unavailable"` cannot be consumed as a miss. The native
temperature path fails closed; unrelated controls may continue under their
existing per-control contract.

### Finish publication

The broker publishes one finish record before releasing the FIFO. It echoes
the begin `epoch`, `transactionSequence`, `cacheGeneration`, and `target`.
`attemptedSettings.tempLimitC` is the actual setter argument only when a setter
was invoked; otherwise it remains `undefined`. `publication` is
`"committed"` when the cache update/no-op was authoritatively processed,
`"not-required"` when no temperature refusal needed learning, or
`"unavailable"` when the result cannot be trusted/published.

```js
{
  type: "temperature-refusal-cache:finish",
  schemaVersion: 1,
  epoch: "<same broker-process session id>",
  transactionSequence: 42,
  cacheGeneration: 8,
  target: { /* same physical target proof as begin */ },
  ranges: { tempLimitC: { units: "C", min: 50, max: 115, step: 1 } },
  attemptedSettings: { tempLimitC: 103 },
  perControl: {
    tempLimitC: { ok: false, errorCode: "out-of-range" }
  },
  publication: "committed",
  cache: {
    status: "available",
    ceilings: { tempLimitC: 102 }
  }
}
```

The publication acknowledgement is not successively inferred from a return
value that merely says a recorder exists: the broker confirms that the
snapshot belongs to this transaction and that the cache update (or deliberate
no-op) completed. Rust validates the tagged message and may mirror it; native
routing must not proceed on a missing, stale, malformed, wrong-epoch, wrong-
target, or unavailable record.

## Stable physical key and inventory resolution

The cache key grammar is:

```text
pci:0x{vendor-8-lowercase-hex}:0x{device-8-lowercase-hex}@{bus}:{slot}.{function}
```

For example: `pci:0x00008086:0x0000e20b@3:0.0`. The PCI identifiers represent
nonzero 16-bit vendor/device IDs zero-padded to eight hexadecimal digits. BDF
components are canonical unsigned decimal integers: bus `0..255`, slot
`0..31`, function `0..7`; the all-zero `(0,0,0)` BDF is the driver's
“not supplied” shape and is not an identity. The key is lowercase and does not
include an Electron ordinal, name, adapter model, or LUID.

Before using a key, the broker resolves the Electron ordinal through a **fresh
inventory read** to exactly one writable row. It validates the row's PCI IDs,
BDF, and canonical key; if an expected LUID is present, the fresh row must
carry the same LUID. The stable key must match exactly one writable row.
Missing/zero BDF, malformed/zero/out-of-domain PCI IDs, absent or conflicting
physical proof, no matching writable row, or multiple matching rows means
identity is unknown/ambiguous: create no cache entry and perform no native
temperature write. Never fall back to an ordinal, name, model, or partially
formed PCI key. Same-model adapters at distinct BDFs have distinct entries.

## Learning rules

Only a driver-produced per-control temperature refusal with
`ok: false, errorCode: "out-of-range"` learns a ceiling. `io-failed`,
unsupported/configuration/OC-mode refusals, successful writes, and results for
other controls do not learn or clear a ceiling.

The broker learns from the exact temperature value passed to the setter:

- Without an explicit driver ceiling, the candidate is
  `attempted - ranges.tempLimitC.step`, normalized to the reported decimal step
  precision to remove floating-point representation noise. For an on-grid
  setter value this is one step lower.
- With `capabilityCeiling`, accept it only if finite, below the refused
  attempted value, within the authoritative `[min,max]` range, and aligned to
  that range's step grid (within the shared floating-point tolerance). An
  invalid explicit ceiling is not reinterpreted as a one-step candidate.
- In either case, only a valid candidate is recorded, and the per-key ceiling
  is monotone: a candidate can lower but never raise it. A successful write
  never clears a learned ceiling.

If a driver temperature refusal has no finite attempted setter value, has an
invalid range/ceiling, or cannot be authoritatively published, the broker
cannot know which values are safe to retry. It poisons the cache availability
for the broker session rather than silently treating the entry as empty.

## Consume and failure rules

For a fresh, available snapshot, a request at or below the effective learned
ceiling may continue through normal preflight. A request above it refuses only
`tempLimitC` with a per-control result equivalent to:

```js
{
  ok: false,
  errorCode: "out-of-range",
  capabilityCeiling: <effective ceiling>,
  message: "The requested temperature limit exceeds the effective ceiling. Nothing was changed."
}
```

Mixed requests retain their other controls and their usual per-control
semantics. If temperature is the only remaining control after preflight, do
not invoke any setter. A poisoned/unavailable cache refuses temperature
requests with `errorCode: "refusal-cache-unavailable"`; never infer a miss from
a stale snapshot. Other controls remain usable where their existing routing
allows it. The unavailable latch is session-scoped and only a broker process
restart clears it.

## Shared differential fixture

`src-tauri/fixtures/temperature-refusal-cache-v1.json` is the Phase 1
cross-language decision corpus. `test/refused-ceilings.test.js` exercises the
Electron refusal-recording helper, while the Rust tests in
`profile_apply_preflight.rs` exercise its cache and identity seams. The fixture
includes learning/monotonicity/success cases, non-finite and non-temperature
results, ordinal reorder, same-model adapters, duplicate/conflicting identity,
and malformed or absent PCI/BDF identity. The `"nonFinite": "NaN"` value is a
JSON-safe test marker; each consumer maps it to its language's non-finite test
value.

Phase 1 does not change routing or cache behavior, wire a Rust preflight, or
authorize hardware access.
