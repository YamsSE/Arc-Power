// Arc Power — renderer-side type mirror of the main-process JSDoc contract
// (src/main/backend/backend.interface.js). Canonical units: W, V, MHz, C,
// GTS, %. Kept in sync with the main-process typedefs by convention; the IPC
// layer is the enforcement point, not these types.

export type OcErrorCode =
  | 'waiver-not-set'
  | 'out-of-range'
  | 'locked-mode'
  | 'reset-required'
  | 'unsupported'
  | 'unavailable-symbol'
  | 'invalid-argument'
  | 'io-failed';

export type FanMode = 'auto' | 'curve' | 'fixed';

/** Apply intent; an absent field means "leave the driver value untouched". */
export interface Settings {
  powerLimitW?: number;
  gpuVoltOffsetV?: number;
  gpuFreqOffsetMhz?: number;
  tempLimitC?: number;
  vramFreqOffsetGts?: number;
  vramVoltOffsetV?: number;
  gpuLock?: { voltageV: number; freqMhz: number };
  vfCurve?: Array<{ voltageV: number; freqMhz: number }>;
  fanMode?: FanMode;
  fanCurve?: Array<{ t: number; speedPct: number }>;
  fixedFanPct?: number;
}

/** Read-back of the device's current state (all supported controls resolved). */
export interface DeviceState {
  powerLimitW: number | null;
  gpuVoltOffsetV: number | null;
  gpuFreqOffsetMhz: number | null;
  tempLimitC: number | null;
  vramFreqOffsetGts: number | null;
  vramVoltOffsetV: number | null;
  gpuLock: { voltageV: number; freqMhz: number } | null;
  vfCurve: Array<{ voltageV: number; freqMhz: number }> | null;
  fanMode: FanMode | null;
  fanCurve: Array<{ t: number; speedPct: number }> | null;
  fixedFanPct: number | null;
}

export interface RangeInfo {
  min: number;
  max: number;
  step: number;
  default: number;
  units: string;
}

export interface Capabilities {
  oemName: string;
  deviceName: string;
  waiverAccepted: boolean;
  controls: Record<string, boolean>;
  ranges: Record<string, RangeInfo>;
  fan: { canControl: boolean; modes: string[]; maxRpm: number; maxCurvePoints: number };
  /** M2C-C: the bundled 2023 IGCL runtime loaded — PL/TL ranges are extended
   *  (max 315 W / 115 C) and applies above the DriverStore clamp route to it. */
  extendedRanges?: boolean;
}

export interface PerControlResult {
  ok: boolean;
  errorCode?: OcErrorCode;
  /** Composed failure text (F3 instant apply: refusals get the actionable
   *  message here; hard errors are mapped via pure/errors.ts errorMessage). */
  message?: string;
  readBackEqual?: boolean;
  /** F3: the driver returned SUCCESS but the read-back did not change (silent no-op — must NOT be reported as applied). */
  silentNoop?: boolean;
}

export interface ApplyResult {
  ok: boolean;
  perControl: Record<string, PerControlResult>;
}

export interface ApplyResponse {
  result: ApplyResult;
  state: DeviceState;
}

export interface ResetResponse {
  state: DeviceState;
}

export interface DeviceInfo {
  id: number;
  name: string;
  type: string;
  pciVendorId: string;
  pciDeviceId: string;
  revId: number;
  bdf: { bus: number; device: number; function: number };
  driverVersion: string;
  graphicsClockMHz: number;
  numXeCores: number;
}

export interface HealthReport {
  backend: string;
  igclLoaded: boolean;
  driverVersion: string | null;
  levelZeroOk: boolean;
  error?: string;
}

/**
 * IGS state — mirrors src/main/igs-service.js. The verified rule
 * (docs/igcl-integration.md §8a): OC writes are refused in the half-states
 * (service.running !== appRunning); fully-on (app + service) and fully-off
 * both work.
 */
export type IgsStartType = 'auto' | 'manual' | 'disabled' | 'unknown';

export interface IgsServiceState {
  service: {
    found: boolean;
    running: boolean;
    startType: IgsStartType;
  };
  appRunning: boolean;
}

/** Result of the elevated disable/enable action over IPC. */
export interface IgsActionResult {
  ok: boolean;
  error?: string;
}

/** M2C-C elevation state (app-elevated IPC). */
export interface ElevationState {
  /** This process runs as administrator. */
  elevated: boolean;
  /** Applies go through the elevated self-worker (product path, not elevated) —
   *  the renderer shows the "Administrator approval is needed" toast then. */
  workerApply: boolean;
}

/** apply-on-startup state (startup-get IPC). `mechanism` reports which
 *  registration is active: the M2C-C elevated scheduled task or the legacy
 *  Run key. */
export interface StartupState {
  enabled: boolean;
  profileId: string | null;
  value: string | null;
  mechanism: 'task' | 'run-key' | null;
}

export interface ThrottleFlags {
  power?: boolean;
  temp?: boolean;
  current?: boolean;
  voltage?: boolean;
  util?: boolean;
}

export interface TelemetrySample {
  t: number;
  gpuClockMhz?: number;
  memClockMhz?: number;
  tempC?: number;
  memTempC?: number;
  vramTempC?: number;
  gpuVoltageV?: number;
  gpuEnergyJ?: number;
  vramEnergyJ?: number;
  totalEnergyJ?: number;
  fanRpm?: number[];
  utilPct?: number;
  powerW?: number;
  throttle: ThrottleFlags;
}

/** A saved profile (mirrors the main-process Profile typedef). */
export interface Profile {
  id: string;
  name: string;
  createdAt: string;
  schemaVersion: number;
  settings: Settings;
  ocOnBoot: boolean;
}

/** Persisted profile-settings envelope (ocOnBoot / activeProfileId). */
export interface ProfileSettingsState {
  waiverAccepted: boolean;
  ocOnBoot: boolean;
  activeProfileId: string | null;
}

/** Profiles IPC envelope: the list + the persisted settings in one response. */
export interface ProfilesEnvelope {
  profiles: Profile[];
  settings: ProfileSettingsState;
}

/** Result of one PresentMon fps-poll (null when FPS is unavailable). */
export interface FpsSample {
  fps: number | null;
  frameTimeMs: number | null;
  gpuBusy: number | null;
}

// ---------------------------------------------------------------------------
// M2D — mock featuresets (mock mode only)
// ---------------------------------------------------------------------------

/** One mock distribution file (mock/featuresets/<id>.json). */
export interface FeaturesetInfo {
  id: string;
  name: string;
  tag: string;
}

/** mock:list-featuresets response (channel absent in real mode). */
export interface MockFeaturesetsResponse {
  featuresets: FeaturesetInfo[];
  current: string;
}

/** mock:set-featureset response — everything the UI renders from one swap. */
export interface MockSwapResponse {
  featureset: FeaturesetInfo;
  devices: DeviceInfo[];
  caps: Capabilities;
  state: DeviceState;
  health: HealthReport;
}
