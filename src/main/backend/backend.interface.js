// Arc Power - M1 backend interface (JSDoc contract).
//
// The IOCBackend contract is the seam every backend implementation (IGCL
// koffi, .NET sidecar later, mock) must satisfy. The .NET sidecar fallback
// (plan §2) is not built in M1 but the interface is kept sidecar-friendly:
// it is async, plain-JSON shaped, and has no koffi/IGCL types leaking out
// (structs and handles stay inside the implementations).
//
// Field/unit conventions (pinned for M1, see plan §6 + docs/igcl-integration.md §4):
//   Settings/DeviceState/Capabilities carry CANONICAL units:
//     W, V, MHz, C, GTS, % - never raw IGCL units.
//   The IgclBackend converts canonical <-> IGCL using the per-control
//   capability units (V2 API contract) - never assumes mV/mW.

/**
 * Apply intent for one device. A null/absent field = "leave the current
 * driver value untouched". Fields are in canonical units.
 * @typedef {{
 *   powerLimitW?: number,
 *   gpuVoltOffsetV?: number,
 *   gpuFreqOffsetMhz?: number,
 *   tempLimitC?: number,
 *   vramFreqOffsetGts?: number,
 *   vramVoltOffsetV?: number,
 *   gpuLock?: { voltageV: number, freqMhz: number },
 *   vfCurve?: Array<{ voltageV: number, freqMhz: number }>,
 *   fanMode?: 'auto' | 'curve' | 'fixed',
 *   fanCurve?: Array<{ t: number, speedPct: number }>,
 *   fixedFanPct?: number,
 * }} Settings
 */

/**
 * Read-back of the device's current state. Every control the device
 * supports is fully resolved (never "untouched"); a field is null only
 * when unsupported on that device. gpuLock reads {voltageV:0, freqMhz:0}
 * when the GPU is not locked (dynamic).
 * @typedef {{
 *   powerLimitW: number|null,
 *   gpuVoltOffsetV: number|null,
 *   gpuFreqOffsetMhz: number|null,
 *   tempLimitC: number|null,
 *   vramFreqOffsetGts: number|null,
 *   vramVoltOffsetV: number|null,
 *   gpuLock: { voltageV: number, freqMhz: number }|null,
 *   vfCurve: Array<{ voltageV: number, freqMhz: number }>|null,
 *   fanMode: 'auto'|'curve'|'fixed'|null,
 *   fanCurve: Array<{ t: number, speedPct: number }>|null,
 *   fixedFanPct: number|null,
 * }} DeviceState
 */

/**
 * Canonical error codes reported in ApplyResult (fixed enum mirroring the
 * IGCL OC error surface, decoupled from raw ctl_result_t values so the
 * sidecar/mock can map 1:1).
 * @typedef {'waiver-not-set'|'out-of-range'|'locked-mode'|'reset-required'
 *   |'unsupported'|'unavailable-symbol'|'invalid-argument'|'io-failed'} OcErrorCode
 */

/**
 * M8 (the Graphics tab): the 3D-feature canonical settings. An absent field
 * = "leave the current driver value untouched". The canonical strings are
 * shared by the page / IPC / backends; the IGCL numeric enum side stays
 * inside the igcl backend.
 * @typedef {{
 *   frameGenOverride?: 'app-choice' | '2x' | '3x' | '4x',
 *   flipMode?: 'application-default' | 'vsync-on' | 'vsync-off' | 'smooth-sync' | 'speed-frame',
 *   frameLimit?: { enabled: boolean, value: number },
 *   lowLatency?: 'off' | 'on' | 'on-boost',
 * }} GraphicsSettings
 */

/**
 * M8: the Graphics tab's read-back (getGraphicsSettings). NEVER throws - all
 * fields degrade to false/null/[] on any failure (the honest "not supported
 * on this GPU" surface the page caps-gates on). `supportedOptions` carries
 * the driver's SupportedTypes-gated option lists (Speed Sync etc.) - the
 * page's dropdown gating source.
 * @typedef {{
 *   supported: { frameGen: boolean, flipModes: boolean, frameLimit: boolean, lowLatency: boolean },
 *   supportedOptions: { frameGen: string[], flipModes: string[], lowLatency: string[] },
 *   frameLimitRange: { min: number, max: number, step: number, default: number } | null,
 *   values: {
 *     frameGenOverride: string | null,
 *     flipMode: string | null,
 *     frameLimit: { enabled: boolean, value: number } | null,
 *     lowLatency: string | null,
 *   },
 * }} GraphicsState
 */

/**
 * @typedef {{
 *   ok: boolean,
 *   perControl: Record<string, { ok: boolean, errorCode?: OcErrorCode, message?: string }>,
 * }} ApplyResult
 */

/**
 * Per-device capability matrix, mapped from ctl_oc_properties_t +
 * ctl_fan_properties_t. `controls` lists which controls exist and are
 * supported on the device; `ranges` holds canonical-unit ranges for every
 * supported control.
 * @typedef {{
 *   oemName: string,
 *   deviceName: string,
 *   waiverAccepted: boolean,
 *   controls: {
 *     gpuFreqOffset?: boolean, gpuVoltOffset?: boolean, gpuLock?: boolean,
 *     vramFreqOffset?: boolean, vramVoltOffset?: boolean,
 *     powerLimit?: boolean, tempLimit?: boolean, vfCurve?: boolean,
 *   },
 *   ranges: Record<string, { min: number, max: number, step: number, default: number, units: string }>,
 *   fan: { canControl: boolean, modes: string[], maxRpm: number, maxCurvePoints: number },
 * }} Capabilities
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   type: string,
 *   pciVendorId: string,
 *   pciDeviceId: string,
 *   revId: number,
 *   bdf: { bus: number, device: number, function: number },
 *   driverVersion: string,
 *   graphicsClockMHz: number,
 *   numXeCores: number,
 *   vramBytes: number|null,  // M4-B: VRAM in bytes (null when unknown) - the
 *                            // name already carries the formatted suffix
 * }} DeviceInfo
 */

/**
 * One raw telemetry sample, mapped 1:1 from IGCL (nullable per field).
 * Power is NOT here - it is derived by TelemetryService from energy deltas.
 * @typedef {{
 *   t: number,
 *   gpuClockMhz?: number, memClockMhz?: number, tempC?: number,
 *   memTempC?: number, vramTempC?: number, gpuVoltageV?: number,
 *   gpuEnergyJ?: number, vramEnergyJ?: number, totalEnergyJ?: number,
 *   fanRpm?: number[], utilPct?: number,
 *   throttle: { power?: boolean, temp?: boolean, current?: boolean, voltage?: boolean, util?: boolean },
 * }} RawTelemetrySample
 */

/**
 * Derived sample emitted by TelemetryService (adds powerW from energy
 * deltas; fps/vramUsedMb arrive in M2b).
 * @typedef {RawTelemetrySample & { powerW?: number }} TelemetrySample
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   createdAt: string,
 *   schemaVersion: number,
 *   settings: Settings,
 *   ocOnBoot: boolean,
 * }} Profile
 */

/**
 * @typedef {{
 *   igclLoaded: boolean,
 *   driverVersion: string|null,
 *   levelZeroOk: boolean,
 *   error?: string,
 * }} HealthReport
 */

/**
 * Unsubscribe function returned by subscription APIs.
 * @typedef {() => void} Unsub
 */

/**
 * IOCBackend - the interface every backend implements.
 * All methods are async; deviceId is the stable index returned by
 * listDevices(). Implementations must never assume the caller's settings
 * are in range: clamp to capability ranges before applying, and verify by
 * read-back. Fan setters must only be invoked when canControl === true -
 * the EFFECTIVE value (properties.canControl || the M3-D reversible probe
 * result on canControl=false devices).
 *
 * @typedef {{
 *   kind: 'igcl'|'mock'|'sidecar',
 *   init(): Promise<void>,
 *   listDevices(): Promise<DeviceInfo[]>,
 *   getCapabilities(deviceId: number): Promise<Capabilities>,
 *   getCurrentSettings(deviceId: number): Promise<DeviceState>,
 *   applySettings(deviceId: number, s: Settings, opts?: { snapToStep?: boolean }): Promise<ApplyResult>,
 *   //   opts.snapToStep defaults to true (product applies snap to the
 *   //   capability step); false writes the value back exactly - reserved for
 *   //   the smoke no-op round trip so an off-grid current value (e.g. the
 *   //   A770's 48.3 MHz offset) is written back unchanged.
 *   resetToDefaults(deviceId: number): Promise<void>,
 *   setWaiverAccepted(deviceId: number): Promise<void>,
 *   // Restore a persisted waiver acceptance into the IN-MEMORY flag ONLY -
 *   // NEVER calls the driver (the contract distinction from
 *   // setWaiverAccepted, which is the only path that runs the driver-side
 *   // waiver set). Used for boot-time seeding (seedWaiverState) and for
 *   // clearing the stale flag when the driver reports the waiver as lost.
 *   restoreWaiverState(deviceId: number, accepted: boolean): Promise<void>,
 *   sampleRawTelemetry(deviceId: number): Promise<RawTelemetrySample>,
 *   onRawTelemetry(deviceId: number, cb: (s: RawTelemetrySample) => void): Unsub,
 *   // M8 (the Graphics tab): the 3D-feature surface (ctlGetSupported3D-
 *   // Capabilities / ctlGetSet3DFeature). getGraphicsSettings NEVER throws
 *   // (degrades to the all-false/null GraphicsState - the honest
 *   // not-supported surface); setGraphicsSettings returns the ApplyResult
 *   // shape with per-feature results (success / igcl error code / refusal).
 *   // NO OC waiver applies to 3D features.
 *   getGraphicsSettings(deviceId: number): Promise<GraphicsState>,
 *   setGraphicsSettings(deviceId: number, s: GraphicsSettings): Promise<ApplyResult>,
 *   health(): Promise<HealthReport>,
 *   close(): Promise<void>,
 * }} IOCBackend
 */

/**
 * Control names used as keys in Settings / DeviceState / perControl.
 * @type {string[]}
 */
export const CONTROLS = [
  'powerLimitW',
  'gpuVoltOffsetV',
  'gpuFreqOffsetMhz',
  'tempLimitC',
  'vramFreqOffsetGts',
  'vramVoltOffsetV',
  'gpuLock',
  'vfCurve',
  'fanMode',
  'fanCurve',
  'fixedFanPct',
];

// M8 (the Graphics tab): the canonical option lists of the four 3D-feature
// controls - the vocabulary shared by the page, the IPC validator, the
// backends and the mock (the numeric IGCL enum side stays inside the igcl
// backend). NOTE: the graphics controls are deliberately NOT in CONTROLS -
// sanitizeSettings (the OC payload validator) must keep rejecting them; the
// graphics apply path has its OWN validator.
export const GRAPHICS_FRAME_GEN_OPTIONS = ['app-choice', '2x', '3x', '4x'];
export const GRAPHICS_FLIP_MODE_OPTIONS = ['application-default', 'vsync-on', 'vsync-off', 'smooth-sync', 'speed-frame'];
export const GRAPHICS_LOW_LATENCY_OPTIONS = ['off', 'on', 'on-boost'];

/**
 * Map an IGCL ctl_result_t code to a canonical OcErrorCode (or null when
 * the code does not map to an OC-specific failure).
 * @param {number} code
 * @returns {OcErrorCode|null}
 */
export function igclErrorCode(code) {
  switch (code >>> 0) {
    case 0x44000008: return 'waiver-not-set';
    case 0x44000002:
    case 0x44000003:
    case 0x44000004:
    case 0x44000005:
    case 0x4400000d: return 'out-of-range';
    case 0x44000006: return 'locked-mode';
    case 0x44000007: return 'reset-required';
    case 0x4400000e: return 'out-of-range'; // invalid custom VF curve
    case 0x4000000a: return 'unsupported';
    // Invalid argument is a caller/driver contract violation - deterministic,
    // never transient: classify as a HARD error (instant fail) in the F3 core.
    case 0x4000000b: return 'invalid-argument';
    default: return null;
  }
}
