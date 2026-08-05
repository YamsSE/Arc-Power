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
}

export interface PerControlResult {
  ok: boolean;
  errorCode?: OcErrorCode;
  message?: string;
  readBackEqual?: boolean;
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

/** IGS (IntelGraphicsSoftwareService) state — mirrors src/main/igs-service.js. */
export type IgsStartType = 'auto' | 'manual' | 'disabled' | 'unknown';

export interface IgsServiceState {
  found: boolean;
  running: boolean;
  startType: IgsStartType;
}

/** Result of the elevated disable/enable action over IPC. */
export interface IgsActionResult {
  ok: boolean;
  error?: string;
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
