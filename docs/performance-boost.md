# Performance Boost Research

## Conclusion

Intel's Performance Boost is not simply a GPU frequency-offset slider. It
modifies the GPU's voltage/frequency behavior, while the separate GPU Voltage
Offset control changes voltage headroom independently.

Performance Boost is meaningful in Intel's tuning software, but it is not a
separate control exposed by the documented IGCL API. Arc Power cannot currently
reproduce the full behavior safely through its public API surface.

The recommended product decision is to keep Performance Boost removed from
Arc Power for now. The app should expose explicit frequency offset, target
clock, voltage offset, power limit, and temperature limit controls instead.

## IGS Behavior

| Control | Effect |
| --- | --- |
| Performance Boost | Shifts frequency targets across the GPU voltage/frequency curve |
| Voltage Offset | Increases voltage headroom and enables higher V/F points |
| Power Limit | Changes the maximum permitted GPU power |
| Temperature Limit | Changes the thermal ceiling |

Performance Boost can therefore result in higher effective operating voltage,
frequency, power draw, and temperature under load. It does not, however, mean
that the separate manual GPU Voltage Offset value has been increased.

Intel describes GPU Performance Boost as adjusting "voltage and frequency
characteristics to improve performance while staying within the same power
limits." Intel lists GPU Voltage Offset, GPU Power Limit, and GPU Temperature
Limit as separate controls.

Third-party A770 analysis describes Performance Boost as offsetting each point
on the voltage/frequency curve. It describes Voltage Offset as enabling
previously restricted portions of that curve. The two controls are
complementary rather than interchangeable.

## Public API Surface

The public IGCL overclocking API exposes independent fields and functions for:

- `gpuFrequencyOffset`
- `gpuVoltageOffset`
- `powerLimit`
- `temperatureLimit`

There is no public IGCL field or setter named Performance Boost. The A770 also
does not expose a usable public custom V/F curve through the current IGCL path.

Relevant project mappings are in:

- `src/main/backend/igcl-bindings.js`
- `src/main/backend/igcl-backend.js`
- `src/main/backend/backend.interface.js`

## What M14 Implemented

The former M14 implementation treated Performance Boost as a percentage
presentation over the existing `gpuFreqOffsetMhz` control:

```text
boostPercent -> round(boostPercent / 100 * frequencyOffsetMax)
```

For the A770, 40% therefore became approximately `+120 MHz`. The apply payload
contained only:

```ts
{ gpuFreqOffsetMhz: value }
```

It did not modify:

- `gpuVoltOffsetV`
- `powerLimitW`
- `tempLimitC`
- a V/F curve

That implementation reproduced only the frequency-offset component. It was
not a faithful implementation of Intel's full Performance Boost behavior.

It also had presentation problems:

- A 1% step represented 3 MHz on the A770, making the percentage view lossy.
- Negative offsets appeared as `0%`, hiding the actual driver state.
- Rounded percentage read-back could turn different MHz values into the same
  displayed value.
- The nested `Performance Boost | Core Clock` and `Offset | Clock` selectors
  created multiple coupled UI states.

M15 removed this presentation, which is the correct direction.

## Implementation Brief

Implement the following decision in Arc Power:

1. Remove the OC Performance Boost presentation completely from the product
   UI and tuning state.
2. Remove the associated renderer helpers, mode flags, selectors, CSS, and
   UI verification cases for the OC Boost presentation.
3. Keep `gpuFreqOffsetMhz` as the only persisted and applied core-frequency
   control.
4. Keep the existing `Offset | Clock` presentation for that control. It must
   remain renderer-only and must not add a profile or backend field.
5. Keep `gpuVoltOffsetV`, `powerLimitW`, and `tempLimitC` as separate explicit
   controls. Do not make a frequency-offset apply write any of them.
6. Preserve the raw canonical frequency-offset value in driver read-back and
   apply comparisons. Clock mode may show an absolute equivalent, but must not
   replace the canonical state or profile value.
7. Do not remove or rename the Graphics feature `lowLatency: 'on-boost'`. That
   is a separate documented 3D-feature control and is unrelated to OC
   Performance Boost.
8. Keep this document as the rationale and historical record. References to
   the former M14 implementation in this document are intentional.

The implementation must not add a `gpuPerfBoostPct` setting, profile field,
schema migration, or undocumented/private driver call.

Verify the change with the project build, `npm test`, and the relevant mock/UI
verification variants. The final implementation should show the core offset
and target-clock controls clearly, while making no claim that Arc Power
emulates Intel's V/F-curve Performance Boost.

## Arc Power Design

Keep one canonical persisted and applied value:

```ts
gpuFreqOffsetMhz
```

Keep these controls independent:

```text
Core Offset / Target Clock
Voltage Offset
Power Limit
Temperature Limit
```

The `Offset` and `Target Clock` choices should remain renderer-only
presentation modes. They should not create additional profile fields or
backend controls.

The UI should make the distinction explicit:

```text
GPU Core Frequency
[ Offset | Target Clock ]

Core Offset: +75 MHz
Equivalent clock: 2475 MHz
Driver: +75 MHz
```

The driver read-back should retain the raw canonical offset even when the
slider is displayed as an absolute clock. This avoids hiding the actual value
that the driver accepted.

## Future Compatibility Option

If exact Intel Graphics Software parity becomes a requirement, first run a
controlled black-box experiment:

1. Reset all tuning values.
2. Record frequency offset, voltage offset, power limit, temperature limit,
   and telemetry.
3. Change only the Intel Performance Boost value at 0%, 25%, 50%, and 100%.
4. Record all public read-backs and telemetry under the same workload.
5. Repeat while changing Voltage Offset independently.

If only frequency offset changes and the V/F behavior is fully represented by
that value, an explicitly labelled `IGS-style Boost (%)` presentation could be
added for verified A-series devices. It must show the equivalent MHz value and
keep raw MHz driver read-back visible.

If hidden V/F state changes that public IGCL cannot expose, Arc Power should not
claim parity. Reproducing that behavior would require a documented API that
does not currently exist or an undocumented Intel Graphics Software path.

## References

- [Intel: How Can I Overclock My Intel Arc GPU Using Intel Arc Control?](https://www.intel.com/content/www/us/en/support/articles/000092590/graphics.html)
- [Intel Graphics Control Library specification](https://intel.github.io/drivers.gpu.control-library/)
- [SkatterBencher: Intel Arc A770 overclocking analysis](https://skatterbencher.com/2023/07/29/skatterbencher-64-intel-arc-a770-overclocked-to-2795-mhz/)
