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
  /** M17: FALSE on OC-locked devices (Arc B50-class) - the driver exposes
   *  no OC control and refuses the warranty waiver (ERROR_UNSUPPORTED_FEATURE).
   *  The waiver prompt/row/gate are skipped on such devices. Absent/undefined
   *  is treated as supported (older payloads). */
  overclockingSupported?: boolean;
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
  /** M4-D: ReBAR verdict - true when the device's memory resources
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
  /** M14: the system-wide USED RAM in bytes (GlobalMemoryStatusEx ->
   *  ullTotalPhys - ullAvailPhys - the Memory row's source). Composed
   *  into BOTH telemetry emit sites (the device + the no-device null
   *  mode) with the fixture-wins shape: the sysStats fixture's
   *  memoryUsedBytes (12400000000 - 12.4 GB) wins, otherwise the
   *  injected detector answers (null -> the honest '-' - never a fake
   *  0). The M12 memoryUtilPct percent field is REPLACED by this. */
  memoryUsedBytes?: number | null;
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

/** M5: the 4 overlay corners (mirrors profile-store.js + pure/overlay.ts). */
export type OverlayPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** M5: the persisted overlay settings (absent on old files -> the defaults). */
export interface OverlaySettings {
  enabled: boolean;
  hotkeyLetter: string;
  position: OverlayPosition;
  scale: number;
  /** M6: the overlay text color (a /^#[0-9a-fA-F]{6}$/ hex - '#ffffff' the
   *  stock white). Applied via CSSOM to the lines + the frametime canvas
   *  stroke by the overlay renderer. */
  color: string;
  /** M6: the ENABLED overlay stat ids (the canonical OVERLAY_STAT_IDS; the
   *  full set the stock default - a stat off -> its field/line vanishes). */
  stats: string[];
  /** M7b (fix 4): the background box behind the HUD - the box is shown
   *  from overlayBgEnabled, the color/opacity become the
   *  --overlay-bg-color / --overlay-bg-opacity CSS vars (black at 0.5 the
   *  defaults). */
  overlayBgEnabled: boolean;
  overlayBgColor: string;
  overlayBgOpacity: number;
}

/** M5: the overlay:get-state envelope (the Settings card + the verify read it). */
export interface OverlayState {
  exists: boolean;
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number } | null;
  position: OverlayPosition;
  scale: number;
  enabled: boolean;
  /** LIVE-derived from the current globalShortcut registration (a failed
   *  register - the accelerator taken by another app - reads false). */
  hotkeyRegistered: boolean;
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
  /** M4-D: closing the window hides it to the tray instead of quitting. */
  closeToTray: boolean;
  /** M4-D2: the Monitoring "Log to file" toggle (absent on old files -> false). */
  monitorLogToFile: boolean;
  /** M4-F: the persisted GPU selection (absent on old files -> null - the
   *  devices[0] fallback resolves at boot; device-set is the ONLY writer). */
  deviceId: number | null;
  /** 1.0.1: the persisted UI theme ('dark'|'midnight'|'light'; absent on
   *  old files -> 'dark' - the absent-field default, no schema bump). */
  theme: Theme;
  /** M5: the software-overlay settings (absent on old files -> the defaults:
   *  enabled false, letter 'O', position 'top-left', scale 1.0 - the same
   *  absent-field mechanism, NO schema bump). */
  overlayEnabled: boolean;
  overlayHotkeyLetter: string;
  overlayPosition: OverlayPosition;
  overlayScale: number;
  /** M6: the overlay text color (absent on old files -> '#ffffff' - the
   *  stock white; same absent-field mechanism, NO schema bump). */
  overlayColor: string;
  /** M6: the enabled overlay stat ids (absent on old files -> the FULL set -
   *  the stock overlay; same absent-field mechanism, NO schema bump). */
  overlayStats: string[];
  /** M7b (fix 4): the overlay background box (absent on old files -> off /
   *  black / 0.5 opacity - the same absent-field mechanism, NO schema
   *  bump). The Appearance card's Background section persists these; the
   *  overlay renderer applies them via CSSOM on every settings push. */
  overlayBgEnabled: boolean;
  overlayBgColor: string;
  overlayBgOpacity: number;
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
  /** M12: the window AVERAGE fps - the CapFrameX harmonic mean (the
   *  frame-weighted mean of the frame times over the 30 s ring, converted);
   *  the same 60-frame floor as the percentiles. The overlay FPS-row AVG
   *  field. */
  avgFps: number | null;
  /** M7a: the 1% Low / 99% FPS percentile stats (null until the sampler's
   *  60-frame floor is reached - the honest '-' on the overlay FPS row). */
  low1Pct: number | null;
  /** M12/M13: the 0.1% Low - the worst-0.1% tail (the ceil(0.999N) boundary +
   *  the weighted tail average); null below the >= 300-frame floor (the
   *  honest '-' on the overlay FPS row - at 300 the tail is the single
   *  worst frame, a noisy-but-honest minimum vs the research's ~1000-frame
   *  recommendation). */
  low01Pct: number | null;
  p99: number | null;
  /** M10a: the foreground window's graphics API - 'dx12' | 'vulkan' |
   *  'dx11' | 'dx10' | 'dx9' | 'opengl' (M10b: dx9 - the DirectX-9
   *  detection; M12: dx10 - the DirectX-10 detection completeness);
   *  null when nothing is detected (the overlay FPS-row badge field
   *  vanishes - the honest "if it's none, it won't display anything"). */
  api: string | null;
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

// ---------------------------------------------------------------------------
// M8 - the Graphics tab (the IGCL 3D-feature surface)
// ---------------------------------------------------------------------------

/** M8: the XeSS frame-generation override options (the IGCL enum values). */
export type FrameGenOverride = 'app-choice' | '2x' | '3x' | '4x';

/** M8: the frame-synchronization (flip-mode) options (the IGCL flag values). */
export type FlipMode = 'application-default' | 'vsync-on' | 'vsync-off' | 'smooth-sync' | 'speed-frame';

/** M8: the low-latency mode options (the IGCL enum values). */
export type LowLatency = 'off' | 'on' | 'on-boost';

/** M8 apply intent; an absent field = leave the driver value untouched. */
export interface GraphicsSettings {
  frameGenOverride?: FrameGenOverride;
  flipMode?: FlipMode;
  frameLimit?: { enabled: boolean; value: number };
  lowLatency?: LowLatency;
}

/** M8: the driver read-back (getGraphicsSettings) - never throws; the
 *  all-false/null shape is the honest "not supported on this GPU" degrade. */
export interface GraphicsState {
  supported: { frameGen: boolean; flipModes: boolean; frameLimit: boolean; lowLatency: boolean };
  /** M8: the driver's SupportedTypes-gated option lists (Speed Sync etc.) -
   *  the page's dropdown gating source. */
  supportedOptions: { frameGen: FrameGenOverride[]; flipModes: FlipMode[]; lowLatency: LowLatency[] };
  frameLimitRange: { min: number; max: number; step: number; default: number } | null;
  values: {
    frameGenOverride: FrameGenOverride | null;
    flipMode: FlipMode | null;
    frameLimit: { enabled: boolean; value: number } | null;
    lowLatency: LowLatency | null;
  };
}

/** M8: the graphics:apply envelope - the FRESH read-back (graphicsState)
 *  for the page's per-control refresh after every apply. */
export interface GraphicsApplyResponse {
  ok: boolean;
  perControl: Record<string, PerControlResult>;
  graphicsState: GraphicsState | null;
}

