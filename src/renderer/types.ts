// Arc Power - renderer-side type mirror of the main-process JSDoc contract
// (src/main/backend/backend.interface.js). Canonical units: W, V, MHz, C,
// GTS, %. Kept in sync with the main-process typedefs by convention; the IPC
// layer is the enforcement point, not these types.

import type { Theme } from './pure/theme.ts';

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

/** M3-C-E: the OC mode - which limit set the device exposes + the apply gate. */
export type OcMode = 'stock' | 'advanced';

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
  /** M4-I (S1): the memory type carried on the caps payload (the igcl
   *  backend derives it once from the token table; the mock fixture
   *  supplies it). Null when unknown. */
  memType?: string | null;
  waiverAccepted: boolean;
  controls: Record<string, boolean>;
  ranges: Record<string, RangeInfo>;
  fan: { canControl: boolean; modes: string[]; maxRpm: number; maxCurvePoints: number };
  /** M2C-C: the bundled 2023 IGCL runtime loaded - PL/TL ranges are extended
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
  /** F3: the driver returned SUCCESS but the read-back did not change (silent no-op - must NOT be reported as applied). */
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
  /** M4-B: VRAM in bytes for the display-name suffix (set by the backend at
   *  listDevices time; null when unknown - iGPU, real backend until the
   *  M4-D sysinfo fallback lands). */
  vramBytes?: number | null;
  /** M4-I (S1): the memory type CARRIED ON THE DEVICE PAYLOAD (the igcl
   *  backend derives it once from the token table; the mock fixture
   *  supplies it) - the renderer's VRAM row never re-derives it. Null when
   *  unknown (the row shows the size only). */
  memType?: string | null;
}

export interface HealthReport {
  backend: string;
  igclLoaded: boolean;
  driverVersion: string | null;
  levelZeroOk: boolean;
  error?: string;
}

/**
 * The last OC apply outcome (M3-A "OC working" health row). Recorded by the
 * overclocking/fan/profiles pages after every apply attempt - honest: the
 * row reads 'never applied' until the first attempt, then ok/failed.
 */
export interface LastApply {
  ok: boolean;
  /** Epoch ms of the attempt. */
  at: number;
  /** Short human detail (what changed / what failed). */
  detail?: string;
}

/** M2C-C elevation state (app-elevated IPC). */
export interface ElevationState {
  /** This process runs as administrator. */
  elevated: boolean;
  /** Applies go through the elevated self-worker (product path, not elevated) -
   *  the renderer shows the "Administrator approval is needed" toast then. */
  workerApply: boolean;
}

// ---------------------------------------------------------------------------
// M3-A - registry hacks catalog (read-side only; applying is M3-B)
// ---------------------------------------------------------------------------

/** One registry value the catalog reads (mirrors src/main/registry-catalog.js). */
export interface RegistryRead {
  path: string;
  /** Value name; null = enumerate the key (fullscreen-optimizations style). */
  value: string | null;
  type: 'DWORD' | 'REG_SZ';
  /** The value (or token) meaning "the tweak is active" for this read. */
  on: string;
  /** The value meaning "the tweak is off" (null when only `on` is meaningful). */
  off?: string;
}

export type RegistryState = 'enabled' | 'disabled' | 'unknown' | 'default';

/** One catalog entry: what it is, what it reads, how to interpret it. */
export interface RegistryEntry {
  id: string;
  name: string;
  description: string;
  /** Requires administrator to change (all of the M3-A catalog does - M3-B). */
  requiresElevation: boolean;
  /** Shown when no read is configured (never in the current catalog). */
  reads: RegistryRead[];
  /** The per-entry label for the absent-everywhere state. */
  absentLabel: string;
  /** M3-B: the elevated apply descriptor (what Enable/Disable/Revert write). */
  apply: RegistryApplyDescriptor;
}

/**
 * One elevated reg.exe command step (M3-B). The renderer never executes
 * these - the IPC resolves them from the catalog in main; they are exposed
 * for honest display (tooltips, revert notes).
 */
export interface RegistryApplyStep {
  kind: 'add' | 'delete';
  path: string;
  value: string;
  /** REG_DWORD etc. (add steps only). */
  type?: string;
  /** The value data (add steps only; decimal - reg.exe stores DWORD). */
  data?: string;
}

/** The M3-B apply surface of one catalog entry. */
export interface RegistryApplyDescriptor {
  /** False = read-only info entry (fullscreen-optimizations) - no buttons. */
  applyable: boolean;
  /** What the revert restores - shown on the card. */
  revertNote: string;
  /** The exact command lists per action (present iff applyable). */
  actions?: Record<'enable' | 'disable' | 'revert', RegistryApplyStep[]>;
}

/** One step's outcome in an apply result (per-step honesty, no silent partial state). */
export interface RegistryApplyStepResult {
  step: number;
  ok: boolean;
  status: 'done' | 'failed' | 'not-run';
  /** Human description of the command ("MPOHack=1 written to HKLM\..."). */
  label: string;
}

/** The registry-apply IPC envelope. */
export interface RegistryApplyResponse {
  ok: boolean;
  /** True when the UAC prompt was declined/timed out - nothing ran. */
  canceled?: boolean;
  /** Honest outcome text (success / partial with the failed step / cancel). */
  message: string;
  /** Every expected step with its true status (done/failed/not-run). */
  perStep: RegistryApplyStepResult[];
}

/** One read's live result + interpretation. */
export interface RegistryReadState {
  read: RegistryRead;
  found: boolean;
  value: string | null;
  state: RegistryState;
  /** Raw read detail for the UI ("0x1" / "not present" / token match). */
  detail: string;
}

/** One entry's live state. */
export interface RegistryEntryState {
  id: string;
  state: RegistryState;
  detail: string;
  reads: RegistryReadState[];
}

/** The registry-catalog IPC envelope. */
export interface RegistryCatalogResponse {
  entries: RegistryEntry[];
  states: RegistryEntryState[];
}

/**
 * M4-D2: the startup-get shape - ONE HKCU Run value serves both toggles;
 * the derivation is composed in main from the raw value + the persisted
 * settings: startWithWindows = value exists AND the Settings toggle is on;
 * applyOnBoot = value exists AND the profile's start-at-boot is on AND an
 * active profile exists.
 */
export interface StartupGetState {
  startWithWindows: boolean;
  applyOnBoot: boolean;
}

/** M4-D: one Win32_VideoController row (AdapterRAM already degraded). */
export interface VideoControllerInfo {
  name: string | null;
  vramBytes: number | null;
  pnpDeviceId: string | null;
  /** M4-I: the controller's display-driver version (works on ANY GPU -
   *  the no-Intel device card's Driver version row source; null when the
   *  CIM query degraded). */
  driverVersion?: string | null;
  /** M4-D (user): ReBAR verdict - true when the device's memory resources
   *  include a multi-GiB BAR (a functioning Resizable BAR), false when only
   *  the small aperture BAR exists, null when unknown. M4-D2: sourced from
   *  BOTH the per-device pnputil resources AND the Win32_AllocatedResource
   *  cross-check (any >= 1 GiB range from either). The PCIe row was
   *  REMOVED (the unpopulated 1/1 pattern made it a permanent '-'). */
  rebarActive: boolean | null;
}

/**
 * M4J (B): the CacheMemoryInfo type is REMOVED with the Cache row (the
 * Win32_CacheMemory query + the l1-l4 payload fields are gone - no dead
 * pins).
 */

/**
 * M4-D: the system-info payload (sysinfo:get IPC) - the dashboard CPU card
 * + the real-GPU VRAM suffix source. `cores`/`speedMhz`/`videoControllers`
 * degrade honestly to null/empty in the os.cpus() fallback.
 */
export interface SysInfo {
  cpu: {
    name: string | null;
    cores: number | null;
    threads: number | null;
    maxClockMhz: number | null;
  };
  ram: { totalBytes: number; speedMhz: number | null; manufacturer: string | null;
    /** M4-H: Win32_PhysicalMemory.SMBIOSMemoryType (SMBIOS Type-17 code;
     *  null when the payload carries none). */
    memoryType: number | null };
  /** M4J (B): Win32_BaseBoard Manufacturer + Product - the Mainboard row
   *  source (the renderer's short-map derives the display label). */
  baseboard: { manufacturer: string | null; product: string | null };
  videoControllers: VideoControllerInfo[];
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
  /** 1.0.1 (m4): OPTIONAL - the no-device telemetry push (telemetry-start
   *  null mode) emits sys-stats-only samples that carry no throttle flags;
   *  nothing reads this field and the log writer does not use it. */
  throttle?: ThrottleFlags;
  /** M4-D2: system stats pushed on every tick (rolling deltas; null = honest '-'). */
  cpuUtilPct?: number | null;
  cpuTempC?: number | null;
  cpuFreqMhz?: number | null;
  gpuMemUsedBytes?: number | null;
  /** M4-H: CPU package wattage from the PowerMeter perf counter
   *  (Win32_PerfFormattedData_PowerMeter_PowerMeter - property 'Power' in
   *  watts). The class is often ABSENT on desktops, so it honestly
   *  degrades to null ('-'). */
  cpuPowerW?: number | null;
  /** M4-I: the OS GPU-utilization counter (the GPUEngine rows for the
   *  matched LUID - per (eng#, engtype) max across the process rows, sum,
   *  cap 100). Null when the counter is unpopulated; the readout tiles
   *  read `gpuUtilPct ?? utilPct` (the no-Intel util source). */
  gpuUtilPct?: number | null;
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

/** Persisted profile-settings envelope (ocOnBoot / activeProfileId / ocMode). */
export interface ProfileSettingsState {
  waiverAccepted: boolean;
  ocOnBoot: boolean;
  activeProfileId: string | null;
  /** M3-C-E: the OC mode ('stock'|'advanced'), persisted in settings.json. */
  ocMode: OcMode;
  /** M4-B: the once-only Advanced OC Mode warning acceptance. */
  advancedModeAccepted: boolean;
  /** M4-D: the Settings-tab fields (absent on old files -> false). */
  startWithWindows: boolean;
  startMinimized: boolean;
  /** M4-D (user): closing the window hides it to the tray instead of quitting. */
  closeToTray: boolean;
  /** M4-D2: the Monitoring "Log to file" toggle (absent on old files -> false). */
  monitorLogToFile: boolean;
  /** M4-F: the persisted GPU selection (absent on old files -> null - the
   *  devices[0] fallback resolves at boot; device-set is the ONLY writer). */
  deviceId: number | null;
  /** 1.0.1: the persisted UI theme ('dark'|'midnight'|'light'; absent on
   *  old files -> 'dark' - the absent-field default, no schema bump). */
  theme: Theme;
}

/** Profiles IPC envelope: the list + the persisted settings in one response. */
export interface ProfilesEnvelope {
  profiles: Profile[];
  settings: ProfileSettingsState;
}

/** Result of one DXGI fps-poll (null when FPS is unavailable). */
export interface FpsSample {
  fps: number | null;
  frameTimeMs: number | null;
  gpuBusy: number | null;
}

// ---------------------------------------------------------------------------
// M2D - mock featuresets (mock mode only)
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

/** mock:set-featureset response - everything the UI renders from one swap. */
export interface MockSwapResponse {
  featureset: FeaturesetInfo;
  devices: DeviceInfo[];
  caps: Capabilities;
  state: DeviceState;
  health: HealthReport;
  /** The featureset's display-driver registry date (null when unverified). */
  driverDate: string | null;
}
