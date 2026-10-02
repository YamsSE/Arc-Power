# Battlemage voltage-frequency curves

Arc Power uses the native IGCL simplified curve table on B570/B580. Each point
is an integer voltage in mV and frequency in MHz. The driver owns the point
count; the editor retains every point and its index.

## Apply and reset

The installed Intel Graphics Software 26.32.2604.4 VF property was inspected
using assembly metadata without loading or executing the assemblies. Its
constructor reads STOCK and LIVE, its setter submits the complete edited array
once, and a successful setter refreshes STOCK then LIVE. The UI adopts that
returned LIVE value. It does not require repeated equal reads or exact equality
between the request and the driver's returned curve.

Arc Power uses that setter sequence for Battlemage. It validates native ranges,
ordering and count and preserves requested frequencies. Reference-aware edits
preserve each requested voltage change relative to the captured native table.
Following the
reported GUI failure, it also observes a bounded window of LIVE results and
requires the latest two samples to retain the same effective result. A native
SUCCESS with unchanged frequencies and relative voltage spacing is reported as
an ignored edit, not as Applied; the requested draft remains editable. Native read errors have bounded
retries; native writes are never automatically replayed. Adapter identity,
transaction serialization and zero core-offset checks remain enforced.

Curve-only Reset stages a default curve and uses the ordinary curve setter.
Arc Power resolves that intent against fresh STOCK immediately before writing.
Full tuning Reset uses `ctlOverclockResetToDefault`; it also resets the scalar
tuning controls. These are distinct operations in IGS and Arc Power.

## Moving voltage origin

On the local B580, 30 successful paired STOCK/LIVE reads on 2026-10-01 returned
first-point voltages from 670mV to 795mV. All samples retained exactly the same
frequencies and relative voltage spacings. A 4mV equality quorum therefore
incorrectly refused a functioning native curve surface.

Passive origin-only movement does not overwrite the editor's snapshot or draft.
Actual frequency, spacing or point-count changes require an explicit refresh.
Failed reads retain the last readable snapshot. A stale draft can be discarded
and refreshed directly, with adapter/page guards on asynchronous results.

Before a write, source reads may differ by a common voltage translation, but
their exact frequencies and relative voltage spacings must still agree. Manual
edits carry the captured LIVE baseline. At the setter boundary, Arc Power maps
each draft voltage delta onto the fresh LIVE reference. This prevents an old
display origin from becoming an unintended whole-curve voltage edit. An explicit
voltage change is retained; frequency values are not changed by this mapping.
Incompatible references are refused before writing. Full-reset
verification similarly compares native shape and frequencies while allowing
different common origins in its separate STOCK/LIVE reads.

## Evidence and limits

An elevated native probe lowered one middle point by 10MHz. All 25 subsequent
LIVE reads retained that frequency. One native default reset restored the
original frequencies in all 25 subsequent reads. This is local B580 evidence;
it does not establish every driver version or physical B570 behavior.

The revised production IPC routes also passed manual Apply, backend reopening,
curve-only Reset, custom profile Apply and full Reset. Each of the three curve
operations used one setter; the full reset used one native reset. Twenty
subsequent reads per operation retained the resulting native shape.

A separate conservative point test requested 1036mV/2820MHz in place of the
1026mV/2830MHz STOCK point. The driver returned 1026mV/2790MHz on its native
voltage grid. Arc Power adopted that LIVE result, which persisted in 25 reads;
the default reset then restored STOCK in 25 reads. Thus an edited voltage can
change the frequency at the driver's native voltage coordinate. Reporting a
different native grid as a failed apply was incorrect; preserving the old
requested draft afterward also misrepresented the applied hardware state.

Newly saved profiles retain their custom curve and its captured STOCK reference.
Apply maps the saved per-point voltage deltas onto fresh STOCK coordinates.
Profiles without a reference retain their legacy absolute-coordinate semantics;
their original voltage intent cannot be inferred from an old curve alone.
A legacy profile that
combines a curve with nonzero scalar offsets must still satisfy the existing
STOCK/custom dependency checks. Relative shape alone cannot classify a saved
curve as STOCK: intentional whole-curve voltage edits have that same shape.

References: [Intel VF API](https://intel.github.io/drivers.gpu.control-library/Control/api.html#ctloverclockreadvfcurve)
and [Intel overclocking sample](https://github.com/intel/drivers.gpu.control-library/blob/master/Samples/Overclocking_Sample/Sample_OverclockAPP.cpp).

## GUI reproduction follow-up

The submitted 41.77-second video showed edits to the ending frequency followed
by a green Applied result even when that edit was ignored. Native B580 probes
reproduced this: a last-point +10MHz request returned SUCCESS but all 20 later
reads retained the old frequency table. Changing both ending points by +50MHz
returned a persistent +30MHz plateau; a middle-point -10MHz edit persisted
exactly. The driver can quantize or remap edits, so arbitrary requested integer
coordinates are not guaranteed to stick.

When the selected Battlemage STOCK table ends in an equal-frequency pair, the
editor links those two frequencies. Editing either endpoint visibly stages both
changes before Apply. This avoids submitting a lone terminal sample as an
independent maximum-frequency anchor. Profiles keep their saved coordinates;
they are not silently rewritten by this editor behavior.

Refresh continues to show the actual native voltage coordinates. If only a
common voltage translation occurred, the editor explains its signed mV change
and does not announce another curve Apply or stack green refresh notifications.
This is measured native read behavior; its physical cause is not established.

The revised production IPC flow verified ignored-edit detection, middle and
terminal-plateau Apply, curve-only Reset, custom profile Apply and full Reset.
Twenty later reads retained each successful effective result. The user's
captured starting custom curve was restored afterward. An isolated Electron
renderer check verified visible linking, the submitted payload, draft retention
after a simulated native no-op, discard/refresh recovery, and the origin notice.

## October 2 input and origin follow-up

A physical B580 probe reproduced the reported 3230-to-3090 MHz shift by submitting
voltage coordinates 100 mV above the fresh native grid. Apply now preserves
manual edits relative to their original LIVE snapshot and rebases those deltas
onto the final fresh native grid immediately before writing. Saved profiles use
their captured STOCK reference; legacy profiles retain absolute semantics.

The production IPC matrix passed lower, middle, endpoint and per-point voltage
edits, repeated profile loads, curve-only reset and full reset, with 20 reads
for each accepted result. A fresh-grid 3230 request returned 3220 through both
Arc Power and the IGS native setup. An ignored 3180 endpoint request remains a
reported driver no-op with its draft retained. The final hardware state was
STOCK. This does not establish B570 hardware behavior or load stability.

Profile capture accepts aligned native grids immediately and stable nonuniform
voltage edits after two identical LIVE/STOCK captures. Ambiguous nonzero uniform
voltage differences are refused after three attempts rather than persisted as
inferred voltage intent. The Chromium editor checks passed real typing, focus,
commit, Apply and profile capture cases. The focused suite passed 184 tests;
pure reference tests cover all integer frequency and voltage values in range.

## Repeated Apply and stable chart follow-up

A repeated physical sequence showed 3230 first resolving to3220, then retaining
3220 on repeated requests; 3247 resolved to3230. A session-only record now
recognizes an identical previously verified normalized request when fresh
STOCK/LIVE displacement, device identity and zero-offset checks still match.
It reports Already active and sends no setter. Reset, scalar changes, failures,
device enumeration/close and observed mismatches invalidate that record.
Unproven ignored edits retain their draft with a warning, never an Applied claim.

Normal help text is fixed. Changing status and controls are below the chart.
The plotting viewport follows a proven common STOCK origin translation, with
accurate voltage tick labels; actual point values, explicit voltage edits and
validation bounds remain unchanged. Chromium checks prove fixed chart bounds
and dot positions after a common100mV shift. The focused suite passed194tests.

## Independent LIVE origin and actual IGS comparison

The viewport now follows accepted LIVE coordinates independently of STOCK.
STOCK-only movement leaves dots and ticks unchanged; uniform LIVE movement pans
accurate voltage ticks while preserving dot positions. Draft voltage edits remain
visible on the frozen accepted viewport. Accepted Apply refreshes the STOCK reset
reference. Editing, dragging, resetting and refreshing are blocked during Apply.
The focused suite passed 195 tests and the real Chromium editor checks passed.

A live comparison with IGS 32.0.101.9033 on this B580 submitted 3230 MHz to the
last point through the actual IGS UI. IGS moved the curve left and read back
3200 MHz; native reads confirmed changes across the curve. IGS Reset Tuning
switched its UI to Off but repeated native reads retained that altered table.
Arc Power's native reset restored STOCK frequencies across 20 subsequent reads.
These results do not prove why IGS remaps values, nor establish exact acceptance
of every requested integer, B570 behavior or stability under load.

## October 2 scalar profile capture follow-up

Battlemage profile saves now omit the VF table whenever either core scalar
offset is active. At zero offsets, exact LIVE==STOCK is omitted; coherent
nonuniform per-point edits still require two matching fresh LIVE/STOCK reads.
An ambiguous uniform voltage-origin shift still refuses save rather than
silently discarding possible VF intent.

The prior capture bug baked a +150 MHz scalar offset into every saved VF
frequency while preserving the separate +150 MHz frequency offset. Profile
summary hides that exact legacy signature, and the shared apply router removes
the duplicate VF payload before splitting its controls; other custom-curve and
offset combinations retain the dependency refusal. Focused profile, routing,
boot and worker checks cover this repair.

The saved B580 profile was reproduced against the native backend: the legacy
mixed apply rejected its two core offsets and applied its VF table; removing
those unintended VF fields let the frequency/voltage offsets, 114% power and
2400 MHz VRAM settings read back over three applies. The card was reset and
verified at STOCK before patching. The post-patch physical route could not be
re-run because Windows canceled its UAC approval prompt; it remains unverified.
