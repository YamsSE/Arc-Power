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

Arc Power follows that sequence for Battlemage. It validates native ranges,
ordering and count, preserves the submitted coordinates, and displays valid
LIVE readback after a successful setter. Native read errors have bounded
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
their exact frequencies and relative voltage spacings must still agree. Custom
requests are never silently shifted to a new voltage origin. Full-reset
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

Saved profiles retain their exact custom coordinates. A legacy profile that
combines a curve with nonzero scalar offsets must still satisfy the existing
STOCK/custom dependency checks. Relative shape alone cannot classify a saved
curve as STOCK: intentional whole-curve voltage edits have that same shape.

References: [Intel VF API](https://intel.github.io/drivers.gpu.control-library/Control/api.html#ctloverclockreadvfcurve)
and [Intel overclocking sample](https://github.com/intel/drivers.gpu.control-library/blob/master/Samples/Overclocking_Sample/Sample_OverclockAPP.cpp).
