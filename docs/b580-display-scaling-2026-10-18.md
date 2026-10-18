# B580 display scaling

## Faults fixed

- The selectors used active IGCL Identity as Display Scaling even when a GPU method was selected. At native resolution the B580 reports Identity because no resizing is needed; its separate preferred GPU method remains valid.
- Changing back to GPU Scaling reset the method to the first list item instead of retaining the supported selected method.
- Custom scaling could start with inactive zero-valued percentages. IGS initializes Custom at 100% x 100% with a hardware modeset, then applies its remembered percentages. Arc Power now verifies that initialization before a different first Custom percentage.
- Retro GET returns `Enable=false, Type=0` when off. That is a valid disabled state without a known method. Arc Power now offers the advertised methods while retaining `method:null` in native readback.
- The old scaling path guessed that `NNScalingState` was the ordinary GPU/Display selector. That registry read/write path has been removed. Global VRR functionality in the same registry module is preserved.
- Retro aliases no longer cause a second output-handle Identity write. Leaving Retro disables its known method before the ordinary scaler transaction; a failed ordinary write restores the previous Retro state.

## IGS evidence and selection state

Read-only IL inspection of installed IGS 26.36.2702.2 established the ordinary IGCL Version 1 request, flag mapping 1/2/4/8/16, and `HardwareModeSet=false`. First Custom entry uses 100/100 with `HardwareModeSet=true`. Retro uses the adapter-level API.

IGS additionally maintains a per-display `General.Scaling.IdentityScaling` model and saves it through `AllDisplaysUserSettings`. Its default Custom X/Y values are 100/100. No IGS binary, decompiled method body, or private settings are copied into Arc Power.

Arc Power keeps active IGCL state, preferred GPU method, and its own accepted Display selector choice separate. Its per-physical-display record is written only after a native transaction is verified. A saved Display choice is honored only while native Identity and the preferred-mode fingerprint still match. A changed fingerprint or contradictory active mode invalidates the override persistently. Remembered Custom percentages are editor values, distinct from inactive native zeros. There is no automatic hardware reapply on startup.

An IGS change that leaves both native fields unchanged cannot be detected; the UI identifies the Arc Power saved selection rather than claiming that it is an independent driver readback.

## Live B580 tests

Physical target: B580 PCI `e20b`, BDF `3:0.0`; MSI G27C4 E3 on DisplayPort. Starting mode: 1920 x 1080 at 180 Hz, active Identity, preferred Aspect Ratio, Retro disabled.

| Test | Native evidence |
| --- | --- |
| GPU Centered, Stretched, Aspect Ratio at native resolution | Each request accepted; preferred type becomes 2, 4, 8 while active remains Identity |
| Display selection and fresh backend instance | Accepted Identity; Arc Power saved Display selection survives reload while preferred type remains 8 |
| Custom 95% x 95% | Verified 100/100 initialization followed by active Custom 16 and exact 95/95 readback |
| Retro Integer and Nearest Neighbour | Enabled/type pairs read back as true/1 and true/2; exit to GPU verifies Retro disabled |
| GPU methods with 1280 x 1024 desktop at 60 Hz | Active types 2/4/8; physical output remains 1920 x 1080, demonstrating GPU resizing |
| Display Scaling with 1280 x 1024 desktop at 60 Hz | Active Identity and physical output 1280 x 1024, demonstrating monitor-managed resizing |
| Display Scaling with 1280 x 1024 desktop at 180 Hz | Driver rejects the physical output mode. Arc Power reports the refusal and does not persist a successful Display selection |

Raw native probes and the integrated product backend were both exercised. Final restoration verified the original 1920 x 1080 at 180 Hz mode, active Identity, preferred Aspect Ratio, and Retro disabled. An independent rollback process was armed for each test sequence and canceled only after restoration. Probe editor-state files were isolated under `.codex/task-artifacts/b580-display-scaling/`; product editor preferences were not populated by the tests. Native driver APIs may maintain their own caches.

The 180 Hz refusal applies to the tested nonnative physical output mode, not to GPU scaling at the normal 180 Hz desktop. Other monitors, driver builds, HDR configurations, and adapters have not been live validated here.

Focused tests cover native layouts and version handling, active versus preferred proof, Custom initialization/rollback, disabled Retro, coupled aliases, stale target rejection, zero ordinary scaling registry calls, persistent selection invalidation, and cross-process-equivalent physical identity. Electron tests verify selector persistence, method retention, Custom editor values, both Retro methods, and rapid selection routing with isolated mock state. Mock UI results are separate from hardware evidence.

## References

- [Intel IGCL API](https://intel.github.io/drivers.gpu.control-library/Control/api.html)
- [Intel IGCL public header](https://github.com/intel/drivers.gpu.control-library/blob/master/include/igcl_api.h)
- [Intel Retro Scaling](https://www.intel.com/content/www/us/en/support/articles/000057030/graphics.html)
