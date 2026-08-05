You are the M1 implementer for Arc Power: an Electron overclocking tool for Intel Arc GPUs. Read `plan.md` (sections 3-7, 9-M1, 10), `AGENTS.md` (pipeline + rules), `docs/igcl-integration.md`, and `tools/probe/` (igcl.mjs + probe.mjs are the verified reference implementation of the IGCL bindings — reuse them, don't reinvent). M0 is complete and approved.

## Milestone goal (plan §9 M1)
Electron skeleton + the entire non-UI core:
- `IOCBackend` interface with three implementations: `IgclBackend` (koffi FFI to the native IGCL runtime, per docs/igcl-integration.md), `MockBackend` (deterministic fixture data — also demo mode), and the interface must stay sidecar-compatible (a .NET sidecar remains the fallback if ever needed — do NOT build it now).
- `TelemetryService` (owns poll cadence 500 ms [IGCL rate limit 50 ms], power-from-energy derivation, ring buffer).
- `ProfileStore` + schemaVersion migrations, atomic writes (temp file + rename).
- `health()`.
- `--headless` smoke mode that exercises the acceptance sequence on the real A770 without a UI.

## Environment & facts (do not re-derive)
- Node 24 + npm 11 installed; Windows; real A770 present (driver 32.0.101.8861).
- IGCL runtime: `C:\Windows\System32\DriverStore\FileRepository\iigd_dch_d.inf_amd64_*\IntelControlLib.dll` — must be re-discovered each launch (DriverStore scan + active-driver-version matching, see tools/probe/igcl.mjs `findIgclDll`). `ctlInit` with **all-zeros UID** + `CTL_INIT_FLAG_USE_LEVEL_ZERO`. Invented UIDs are rejected on this driver — do not rely on them.
- Capability matrix on this A770 (units from `ctl_oc_properties_t`): gpuFrequencyOffset 0-300 MHz step 1; gpuVoltageOffset 0-0.234 V step 0.005 (V1 API = mV fixed, V2 = capability units); powerLimit 105-252 W step 1 default 210 (V1 = mW fixed, V2 = W); temperatureLimit 60-90 °C. VRAM offsets + VF curves unsupported (hide/absent). Fan: `canControl=false` via IGCL on this card → fan controls read-only (still read config/state; do NOT attempt fan setters when canControl=false). Telemetry: 13/25 item fields + fanSpeed[0] (see docs §9); power derived from energy-counter deltas; 50 ms rate limit.
- Per-API unit contract (pinned): V1 get/set is fixed mW/mV; V2 follows capability units. **Backend must use V2 + capability-unit conversion**, with Settings fields in canonical units (W, V, MHz, °C, %, fan curve %).

## Architecture decisions for this milestone
- **Main process in plain ESM JavaScript with JSDoc typedefs** (no TS build step yet; renderer TS arrives in M2a). Tests with `node:test` (no extra deps). Dependencies: `koffi` (runtime dep), `electron` (devDep, for the skeleton). Do NOT add other deps without a strong reason.
- Layout:
  ```
  package.json            (scripts: test, start, smoke, typecheck-not-needed)
  src/main/backend/backend.interface.js   (JSDoc IOCBackend)
  src/main/backend/igcl-backend.js        (koffi bindings — reuse tools/probe/igcl.mjs struct defs + discovery)
  src/main/backend/mock-backend.js
  src/main/backend/index.js               (factory: real vs mock via env)
  src/main/telemetry/telemetry-service.js
  src/main/store/profile-store.js
  src/main/store/migrations.js
  src/main/health.js
  src/main/main.js                        (Electron entry; --headless runs smoke sequence and exits)
  src/main/smoke.js
  test/…                                  (node:test files, one per module)
  ```
- Electron skeleton: `main.js` must open no window in headless mode; in normal mode a bare window is fine (UI comes in M2a). Smoke mode: `npm run smoke` (or `electron . --headless`) runs: init → discover runtime → listDevices → getCapabilities → getCurrentSettings → no-op apply round trip (set each supported control to its own current value) → telemetry ticks (3 samples, ≥50 ms apart) → reset ONLY if a change was detected → health report → exit 0 on success.
- **Waiver**: calling `ctlOverclockWaiverSet` is allowed in headless/smoke mode (developer's own machine, no value changes). Product code (M2a) must gate it behind explicit user acceptance — structure the backend so the waiver call happens only when the backend is constructed with `allowAutoWaiver: true` (smoke/tests) or an explicit `setWaiverAccepted()`.
- MockBackend: deterministic fixtures matching the A770 matrix above (same ranges/units), telemetry that ramps deterministically, so all UI/tests later run without hardware.

## Data model (plan §6) — implement exactly
- `Settings` (apply intent; null = leave current driver value untouched): powerLimitW?, gpuVoltOffsetV?, gpuFreqOffsetMhz?, tempLimitC?, vramFreqOffsetGts?, vramVoltOffsetV?, gpuLock? {voltageV, freqMhz}, vfCurve?, fanMode? "auto"|"curve"|"fixed", fanCurve? [{t, speedPct}], fixedFanPct?
- `DeviceState` (read-back; every supported control resolved, null only when unsupported).
- `ApplyResult` { ok, perControl: Record<control, {ok, errorCode?, message?}> } with the IGCL error enum (waiver-not-set, out-of-range, locked-mode, reset-required, unsupported, unavailable-symbol).
- `Capabilities` per §6. `TelemetrySample` per §6 (powerW computed by TelemetryService from energy deltas; vramUsedMb/fps not in M1).
- `Profile` per §6; persistence at `%APPDATA%\ArcPower\profiles.json` + `settings.json` with schemaVersion + migrations (pure functions) + atomic writes; refuse to load unknown/newer schema versions with a clear error.
- `health()` returns { igclLoaded, driverVersion, levelZeroOk, error? }.

## Checkpoints — STOP, run build/tests, fix reds, then continue (required)
1. **After igcl-backend.js binding module + interface types compile**: run `node --test` on the fixture-based binding tests (struct marshalling pinned with recorded fixture buffers — reuse the values in tools/probe/out/*.json).
2. **After IgclBackend init + discovery + capabilities + apply/read-back/reset** (mock-tested AND real-device no-op apply in smoke mode on the A770: `node electron . --headless` — must not change GPU state).
3. **After TelemetryService + ProfileStore + migrations**: unit tests green; atomic-write test (simulated crash mid-write); migration test (old-version fixture JSON → migrated).
4. **Final**: full `node --test` green, `npm run smoke` green on the real A770 (report its key lines), `npm start` boots an empty window.

## Safety rules (hard)
- Never set a value different from the device's current value in smoke/tests. No-op applies only. Reset only if a change was detected.
- Waiver only under `allowAutoWaiver` (smoke/tests). Never auto-accept in code paths that will serve the product.
- Do not touch the installed IGS/driver files. No git commits.
- Fan setters: only ever called when `canControl === true` (on this A770 they must not be called at all).

## Deliverables (report back)
- File tree + what each module does.
- `npm test` result summary (pass counts).
- Smoke run key lines (init/discovery/caps/no-op round trips/telemetry/health).
- Any deviations from the plan §7 interfaces (with justification).
- Open risks for M2a.
