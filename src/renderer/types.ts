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
  | 'permission-denied'
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
  /** M17b: the persisted chip-name row-labels flag (APPENDED - the OC
   *  apply surface never reads it; it mirrors the settings.json field so
   *  the spread-save shapes stay type-complete). Absent -> false (the
   *  stock 'CPU '/'GPU ' prefixes). */
  overlayChipNames?: boolean;
  /** M17e: the persisted overlay telemetry push cadence (ms - the
   *  Overlay Settings polling-rate slider; the telemetry-service default
   *  400 - M17g: the stock polling rate FLIPS 500 -> 400, the slider range
   *  100-2000). APPENDED - the OC apply surface
   *  never reads it; it mirrors the settings.json field. */
  overlayPollMs?: number;
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
  /** M17e (N9): the VF-curve read-back UNITS status. The real backend
   *  surfaces the raw uint32 Voltage into `vfCurve` (the header documents
   *  no unit for it - the lock API's mV-vs-V lie is the suspicion, but NO
   *  blind conversion) + sets this token until a vfCurve-capable device
   *  probe pins the scale. Null/absent = the units are the canonical volts
   *  shape (the mock's stored curve). */
  vfCurveUnits?: string | null;
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

/** M17e: the per-device gpuLock bounds (the caps.lockRange payload) in
 *  CANONICAL units - the min/max the lock editor + the clamp consume.
 *  Absent when the driver reports no lock range (the documented fallback
 *  bounds apply then). Derived from ctl_oc_properties_t
 *  gpuVFCurveVoltageLimit / gpuVFCurveFrequencyLimit THROUGH the units
 *  decode (igclToCanonical - never a raw pass: the fields carry a units
 *  int32 with the same mV hazard the lock API proved). */
export interface LockRange {
  voltMin: number;
  voltMax: number;
  freqMin: number;
  freqMax: number;
}

export interface Capabilities {
  oemName: string;
  deviceName: string;
  /** Stable PCI/BDF identity shared by device enumeration and apply routing. */
  deviceKey?: string | null;
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
  fan: { canControl: boolean; modes: string[]; maxRpm: number; maxCurvePoints: number; speedUnits?: 'percent' | 'rpm' };
  /** M2C-C: the bundled 2023 IGCL runtime loaded - PL/TL ranges are extended
   *  (max 375 W / 115 C - M21: the PL max is the sysman-primary ceiling; the
   *  >315 W range applies through the sysman pair) and applies above the
   *  DriverStore clamp route to it. */
  extendedRanges?: boolean;
  /** M48: independent Advanced writers (Sysman W, bundled V1 C). */
  extendedControls?: { powerLimitW?: boolean; tempLimitC?: boolean };
  /** Native capability versus runtime refusal status for controls whose
   * symbols may exist without a writable driver implementation. */
  controlStatus?: Record<string, { state: 'unknown' | 'available' | 'unsupported' | 'runtime-refused'; reason: string | null }>;
  /** M46: selected OC mode controls displayed W/C ceilings independently
   * from the bundled-runtime capability flag. */
  ocMode?: 'stock' | 'advanced';
  /** M17c: the APPENDED AIB-identity fields (absent -> null). The backend
   *  decodes them from the IGCL subsystem fields (pci_subsys_vendor_id /
   *  pci_subsys_id) at enumeration + the laptop-manufacturer branch from the
   *  sysinfo laptop fields; the renderer's device-scoped pins + the
   *  Dashboard AIB row key on them. */
  pciDeviceId?: string | null;
  aibVendor?: string | null;
  aibModel?: string | null;
  /** M17e: the per-device gpuLock bounds (the props-derived canonical
   *  values; absent -> the documented fallback bounds + the pure
   *  lock-ranges table). The card inputs + the renderer clamp consume it;
   *  main's applyLock is the authoritative clamp. */
  lockRange?: LockRange;
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
  /** M10b: the honest modeset-flash note the scaling apply carries (the
   *  physical-modeset warning surfaced via the apply-result toast). */
  warning?: string;
  /** Backend-only companion write; keep it out of the user-facing toast. */
  internal?: boolean;
}

export interface ApplyResult {
  ok: boolean;
  perControl: Record<string, PerControlResult>;
  /** M17g: the PL2 note - the apply's burst-domain verdict riding the
   *  envelope next to perControl. Emitted (non-null) on EVERY W-unit
   *  powerLimitW apply in BOTH modes:
   *   - STOCK: { landed: true, valueW } - the primary V2 write's verdict
   *     (both limits landed per the stock-path behavior; perControl
   *     already verified the write);
   *   - ADVANCED: the V2 companion verdict - landed, or refused above the
   *     DriverStore ceiling ({ landed: false, ceilingW, valueW } - the
   *     burst stays at its CURRENT value, the sustained (PL1) limit is
   *     set).
   *  Null when the payload carried no W-unit powerLimitW (or the write
   *  failed - nothing to note). The Tuning PL card's '(set)' session state
   *  feeds from it. Absent/omitted on the worker envelope when null (the
   *  old envelope-shape pins stay green).
   *  M17o: the CLAMP verdict also carries requestedW (the requested burst -
   *  the read-out's promise sentence keys on valueW < requestedW). */
  pl2Note?: { landed: boolean; ceilingW?: number; valueW?: number; requestedW?: number } | null;
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
  /** IGCL graphics_adapter_properties bit 0. */
  integrated?: boolean;
  /** Name-derived mobile SKU fallback used for telemetry policy. */
  mobile?: boolean;
  /** Stable PCI/BDF identity; session `id` is intentionally not durable. */
  deviceKey?: string;
  /** M4-B: VRAM in bytes for the display-name suffix. */
  vramBytes?: number | null;
  /** Shared system-memory capacity; never included in VRAM/name formatting. */
  sharedMemoryBytes?: number | null;
  sharedMemorySource?: string | null;
  /** M4-I: memory type carried by the backend. */
  memType?: string | null;
  /** M17c: IGCL subsystem fields carried on the device payload. */
  pciSubsysVendorId?: number | null;
  pciSubsysId?: number | null;
  /** M30 unified Windows/IGCL inventory metadata. */
  synthetic?: boolean;
  backendKind?: string;
  gpuVendor?: string | null;
  osController?: {
    name: string;
    vramBytes: number | null;
    sharedMemoryBytes?: number | null;
    sharedMemorySource?: string | null;
    pnpDeviceId: string | null;
    driverVersion: string | null;
    rebarActive: boolean | null;
    luid?: unknown;
  } | null;
  osLuid?: unknown;
}

export interface HealthReport {
  backend: string;
  igclLoaded: boolean;
  driverVersion: string | null;
  levelZeroOk: boolean;
  error?: string;
}

/**
 * M17f: the sysman power-limit read-out (the 'power-limits:read' channel) -
 * the sustained (PL1) + burst (PL2) + peak limits in W when the Level Zero
 * Sysman layer answers; null when it is absent (the honest '-' on the
 * power-limit card).
 */
export interface PowerLimitsRead {
  sustainedW: number;
  burstW: number;
  peakW: number;
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
  /** Shared system-memory capacity, when Windows exposes it. */
  sharedMemoryBytes?: number | null;
  sharedMemorySource?: string | null;
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

/**
 * M17d (round-1 S2): the vendor-lane STATIC-INFO payload (vendor-info:get) -
 * the no-Intel dashboard VRAM/Compute rows' source. vramBytes = the vendor
 * adapter's total-VRAM (NVML memory total primary; the OS controller bytes
 * stay the renderer-side fallback; ADL exposes none -> null - honest);
 * computeCores = the compute-core count (NVML numGpuCores; null when the
 * vendor lane has no source - honest '-'). Nulls never lie.
 */
export interface VendorDeviceInfo {
  vramBytes: number | null;
  computeCores: number | null;
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
  /** Main-process session identity; stale handover samples are ignored. */
  deviceId?: number | null;
  deviceKey?: string | null;
  sessionGeneration?: number;
  gpuClockMhz?: number;
  memClockMhz?: number;
  tempC?: number;
  memTempC?: number;
  vramTempC?: number;
  gpuVoltageV?: number;
  gpuEnergyJ?: number;
  vramEnergyJ?: number;
  totalEnergyJ?: number;
  /** Raw energy counter selected by the backend for integrated/mobile power. */
  powerEnergyJ?: number;
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
  /** Live GPUAdapterMemory usage source for the selected adapter. */
  gpuMemorySource?: 'dedicated' | 'shared' | null;
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
  /** M24: the overlay THEME ('arc' the product default - the Intel-Arc
   *  harness redesign; 'classic' the original HUD, one click away via the
   *  Overlay Settings Theme row). NOTE: the PUSHED-PAYLOAD name shortens to
   *  'theme' - the settings.json key + the profilesList envelope keep the
   *  full 'overlayTheme' (the two surfaces deliberately differ). The
   *  renderer applies the theme from the push (dataset.overlayTheme +
   *  dataset.themeStroke). */
  theme: 'classic' | 'arc';
  /** M6: the ENABLED overlay stat ids (the canonical OVERLAY_STAT_IDS; the
   *  full set the stock default - a stat off -> its field/line vanishes). */
  stats: string[];
  /** M35: selected overlay GPU durable keys; null means monitor all. */
  deviceKeys: string[] | null;
  /** M7b (fix 4): the background box behind the HUD - the box is shown
   *  from overlayBgEnabled, the color/opacity become the
   *  --overlay-bg-color / --overlay-bg-opacity CSS vars (black at 0.5 the
   *  defaults). */
  overlayBgEnabled: boolean;
  overlayBgColor: string;
  overlayBgOpacity: number;
  /** M17b: the chip-name row labels - the overlay:settings payload flag
   *  (absent on old pushes -> false = the stock 'CPU '/'GPU ' prefixes;
   *  the renderer fetches + applies the chip names only when this is on). */
  overlayChipNames: boolean;
  /** M17e: the overlay telemetry push cadence (ms - the overlay:settings
   *  payload field; absent on old pushes -> 400 = the telemetry-service
   *  default - M17g: the stock polling rate FLIPS 500 -> 400. The cadence
   *  itself is owned main-side (ipc-core's
   *  startTelemetry + the live restart); the payload carries it so the
   *  renderer + the verify pins know the setting end-to-end). */
  overlayPollMs: number;
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

/** M23/M51: the ADVANCED-overlay settings push payload. Software theme
 * follows the main window; the Basic Overlay's classic/arc theme is separate. */
export interface AdvancedOverlaySettings {
  position: 'left' | 'right';
  enabled: boolean;
  hotkeyLetter: string;
  theme: Theme;
  /** Monitored values mirrored from the Overlay Settings page. */
  stats: string[];
}

/** M23: the advanced-overlay:get-state envelope (the Overlay view's
 *  Advanced card + the verify read it; hotkeyRegistered is derived LIVE
 *  from the SECOND hotkey seam). */
export interface AdvancedOverlayState {
  exists: boolean;
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number } | null;
  position: 'left' | 'right';
  enabled: boolean;
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
  /** Persisted GPU selection; numeric ids without deviceKey are unverified. */
  deviceId: number | null;
  deviceKey: string | null;
  /** 1.0.1: the persisted UI theme ('dark'|'midnight'|'light'; absent on
   *  old files -> 'dark' - the absent-field default, no schema bump). */
  theme: Theme;
  /** M5: software overlay settings. */
  overlayEnabled: boolean;
  overlayHotkeyLetter: string;
  overlayPosition: OverlayPosition;
  overlayScale: number;
  /** M6: the overlay text color (absent on old files -> '#ffffff' - the
   *  stock white; same absent-field mechanism, NO schema bump). */
  overlayColor: string;
  /** M6: the enabled overlay stat ids (M17g: absent on old files -> the
   *  DEFAULT set - the user's 11 ON / the others OFF, the M6 full-set
   *  default FLIPS; same absent-field mechanism, NO schema bump). */
  overlayStats: string[];
  /** M35: the overlay GPU selection keyed by durable hardware identity.
   *  Null preserves the all-GPU default; an explicit list selects lanes. */
  overlayDeviceKeys: string[] | null;
  /** M7b (fix 4): the overlay background box (absent on old files -> off /
   *  black / 0.5 opacity - the same absent-field mechanism, NO schema
   *  bump). The Appearance card's Background section persists these; the
   *  overlay renderer applies them via CSSOM on every settings push. */
  overlayBgEnabled: boolean;
  overlayBgColor: string;
  overlayBgOpacity: number;
  /** M17b: the chip-name row labels - absent on old files -> false (the
   *  stock 'CPU '/'GPU ' prefixes; same absent-field mechanism, NO schema
   *  bump). The Overlay Settings page's chip-name checkbox persists this. */
  overlayChipNames: boolean;
  /** M17e: the overlay telemetry push cadence - absent on old files -> 400
   *  (the telemetry-service default - M17g: the stock polling rate FLIPS
   *  500 -> 400; same absent-field mechanism, NO
   *  schema bump). The Overlay Settings page's polling-rate slider
   *  persists this. */
  overlayPollMs: number;
  /** M24: the overlay THEME (the settings.json key + the profilesList
   *  envelope keep the FULL name 'overlayTheme' - the pushed overlay
   *  payload shortens to 'theme'; the two surfaces deliberately differ).
   *  Absent on old files -> 'arc' (the redesign IS the product default; the
   *  same absent-field mechanism, NO schema bump). The Overlay Settings
   *  Appearance card's Theme row persists this. */
  overlayTheme: 'classic' | 'arc';
  /** M23: the ADVANCED overlay (the AMD-Adrenaline-style interactive side
   *  panel - CONTROL + <letter>, stock P; absent on old files -> the
   *  defaults: off / 'P' / 'right' - the same absent-field mechanism, NO
   *  schema bump; NO scale key - the panel is a fixed compact size). */
  advancedOverlayEnabled: boolean;
  advancedOverlayHotkeyLetter: string;
  advancedOverlayPosition: 'left' | 'right';
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
  /** Stable key for the requested physical slot, independent of new ids. */
  activeDeviceKey: string;
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

// ---------------------------------------------------------------------------
// M10b - the Graphics "Display" view (the IGCL display-output surface)
// ---------------------------------------------------------------------------

/** M10b: the display-view apply intent for ONE display (an absent field =
 *  leave the driver value untouched). The canonical strings mirror the
 *  main-side contract (backend.interface.js option lists); the scalingMode
 *  values are the driver's scaling-type FLAG names. */
export interface DisplaySettings {
  quantizationRange?: 'default' | 'limited' | 'full';
  wireFormat?: { model: 'RGB' | 'YCbCr420' | 'YCbCr422' | 'YCbCr444'; depth: number };
  /** Raw IGCL ordinary scaling type used behind the IGS-style view. */
  scalingMode?: 'identity' | 'centered' | 'stretched' | 'aspect-ratio-centered-max' | 'custom';
  /**
   * IGS Display > Scaling Method. The available values depend on the
   * selected Scaling Mode: GPU uses the raw GPU scaler flags, Display uses
   * Maintain Display Scaling/Custom, and Retro uses its two retro methods.
   */
  displayScalingMethod?: 'maintain-display-scaling' | 'custom' | 'centered' | 'stretched' | 'aspect-ratio-centered-max' | 'integer' | 'nearest-neighbour';
  /** Custom GPU-scaling percentages from ctl_scaling_settings_t. */
  scalingCustom?: { x: number; y: number; hardwareModeSet?: boolean };
  /** Legacy retro-scaling shape retained for older callers. */
  scalingMethod?: { enabled: boolean; method: 'integer' | 'nearest-neighbour' };
  /** IGS global Variable Refresh Rate mode. */
  globalVrrMode?: 'fullscreen' | 'fullscreen-windowed' | 'disabled';
  /** IGS Variable Refresh Rate enabled/disabled switch. */
  variableRefreshRate?: boolean;
  vrrMode?: 'recommended' | 'excellent' | 'good' | 'compatible' | 'off' | 'vesa' | 'custom';
  hue?: number;
  saturation?: number;
  brightness?: number;
  contrast?: number;
}

export interface GameProfileGraphics {
  enduranceGaming?: 'off' | 'on';
  frameGenOverride?: FrameGenOverride;
  flipMode?: FlipMode;
  frameLimit?: { enabled: boolean; value: number };
  lowLatency?: LowLatency;
}

export interface GameApplication {
  exePath: string;
  processName: string;
  displayName: string;
  source: 'scan' | 'manual';
  artwork?: string;
  /** Optional local game banner cached by the main-process catalog. */
  banner?: string;
}

export interface GameCatalogEntry extends GameApplication {
  createdAt: string;
  updatedAt: string;
}

export interface GameSettingsRecord {
  exePath: string;
  enabled: boolean;
  /** Optional OC preset applied while this executable is running. */
  tuningProfileId: string | null;
  graphics: GameProfileGraphics;
  createdAt: string;
  updatedAt: string;
}

export interface GameAssociation {
  id: string;
  profileId: string;
  exePath: string;
  processName: string;
  displayName: string;
  source: 'scan' | 'manual';
  artwork?: string;
  banner?: string;
  enabled: boolean;
  graphics: GameProfileGraphics;
  createdAt: string;
  updatedAt: string;
}

export interface GameProfilesEnvelope { associations: GameAssociation[]; }
export interface GameCatalogEnvelope { catalog: GameCatalogEntry[]; settings: GameSettingsRecord[]; }

/** A capability/value pair used for Display rows that may be exposed by one
 * driver family but not another. `controllable` is never inferred from a
 * value: it is only true when the backend has a verified write + read-back
 * contract. */
export interface DisplayCapability<T> {
  value: T | null;
  supported: boolean | null;
  controllable: boolean;
  reason: string | null;
  source: string;
}

/** M10b: the driver read-back (getDisplaySettings) - never throws; the
 *  { displays: [] } shape is the honest "no display outputs" degrade (the
 *  no-controls surface the page renders honestly). */
export interface DisplayState {
  deviceKey?: string | null;
  adapterName?: string | null;
  displays: Array<{
    id: number;
    /** Stable physical output identity. Ordinal `id` is display-only and is
     * never accepted by the write path. */
    displayKey?: string | null;
    identityVerified?: boolean;
    name: string | null;
    adapterName?: string | null;
    connection: 'DisplayPort' | 'HDMI' | 'DVI' | 'MIPI' | 'CRT' | 'Unknown';
    resolution: { width: number; height: number } | null;
    refreshRate: number | null;
    colorDepth: number | null;
    colorFormat: string | null;
    quantizationRange: 'default' | 'limited' | 'full' | null;
    scalingMode: string | null;
    /** Active/native scaler state. The IGS-style selector uses the persisted
     * preference below when the driver reports an identity active mode. */
    preferredScalingMode?: string | null;
    /** Adapter-level GPU-vs-Display preference when the native surface cannot
     * identify the exact GPU scaler method. */
    scalingPreference?: 'gpu-scaling' | 'display-scaling' | null;
    scalingDetails?: { customX: number; customY: number; hardwareModeSet: boolean; preferredScalingType: string | null; registryScalingState?: number } | null;
    scalingMethod?: DisplayCapability<{ enabled: boolean; method: 'integer' | 'nearest-neighbour' }>;
    vrrMode?: DisplayCapability<'recommended' | 'excellent' | 'good' | 'compatible' | 'off' | 'vesa' | 'custom'>;
    globalVrrMode?: DisplayCapability<'fullscreen' | 'fullscreen-windowed' | 'disabled'>;
    variableRefreshRate?: DisplayCapability<boolean>;
    vrrCurrentRange?: DisplayCapability<string>;
    vrrMaximumRange?: DisplayCapability<string>;
    hdcpSupport?: DisplayCapability<boolean>;
    fourKSupport?: DisplayCapability<boolean>;
    hdrSupport?: DisplayCapability<boolean>;
    hue?: DisplayCapability<number>;
    saturation?: DisplayCapability<number>;
    brightness?: DisplayCapability<number>;
    contrast?: DisplayCapability<number>;
    supportedOptions: {
      scalingModes: string[];
      scalingMethods: string[];
      vrrModes: string[];
      globalVrrModes: string[];
      wireFormats: string[];
      bpcDepths: number[];
      quantizationRanges: string[];
      colorRanges?: Record<string, { min: number; max: number; step: number; default?: number }>;
    };
    flags: { active: boolean; attached: boolean; dongleConnected: boolean; ditheringEnabled: boolean };
    arcSync: { supported: boolean; minRefreshHz: number | null; maxRefreshHz: number | null; profile: string | null };
  }>;
}

/** M10b: the display:apply envelope - the FRESH read-back (displayState)
 *  for the page's per-control refresh after every apply. */
export interface DisplayApplyResponse {
  ok: boolean;
  perControl: Record<string, PerControlResult>;
  displayState: DisplayState | null;
}

// Recording settings and renderer tabs. Encoder support is deliberately
// represented as three facts: enumeration is not hardware validation, and
// AV1 may only become supported after a real start succeeds.
export type RecordingMode = 'manual' | 'clips';
export type RecordingTab = 'manual' | 'clips';
export type RecordingResolution = 'default' | '480p' | '720p' | '900p' | '1080p' | '1440p' | '4k';
export interface RecordingHotkeys { start: string; stop: string; saveClip: string; }
export type RecordingAudioSourceMode = 'game' | 'system' | 'custom';
export interface RecordingMicrophoneSettings { enabled: boolean; deviceId: string; volume: number; mono: boolean; }
export interface RecordingSystemAudioSettings { enabled: boolean; deviceId: string; volume: number; }
export interface RecordingAudioSettings {
  microphone: RecordingMicrophoneSettings;
  system: RecordingSystemAudioSettings;
  sourceMode: RecordingAudioSourceMode;
  customProcesses: string[];
}
export type RecordingSettingsPatch = Partial<Omit<RecordingSettings, 'hotkeys' | 'audio'>> & {
  hotkeys?: Partial<RecordingHotkeys>;
  audio?: Partial<Omit<RecordingAudioSettings, 'microphone' | 'system'>> & {
    microphone?: Partial<RecordingMicrophoneSettings>;
    system?: Partial<RecordingSystemAudioSettings>;
  };
};
export interface RecordingSettings {
  location: string;
  runtimePath: string;
  mode: RecordingMode;
  fps: 30 | 60 | 120;
  resolution: RecordingResolution;
  encoderId: string;
  bitrateKbps: number;
  replayLengthSec: number;
  audio: RecordingAudioSettings;
  hotkeys: RecordingHotkeys;
}
export interface RecordingAudioDevice { id: string; deviceId: string; name: string; }
export interface RecordingEncoderState {
  type: string;
  description: string;
  enumerated: boolean;
  probeValid: boolean;
  startTested: boolean;
  startSupported: boolean;
  code: number | null;
  status: string;
}
export interface RecordingEngineState {
  available: boolean;
  running: boolean;
  mode: 'video' | 'replay' | null;
  startedAt: number | null;
  error: string | null;
  encoders: RecordingEncoderState[];
  audioInputs: RecordingAudioDevice[];
  audioOutputs: RecordingAudioDevice[];
  hotkeys: { registered: Record<string, string>; conflicts: Record<string, string>; error: string | null };
  lastEvent?: Record<string, unknown> | null;
}
export type RecordingAction = 'start' | 'stop' | 'saveClip';
/** Raw main-process engine state; the renderer-only hotkeys envelope is added by IPC state pushes. */
export type RecordingActionState = Omit<RecordingEngineState, 'hotkeys'>;
export interface RecordingActionResult {
  action: RecordingAction;
  ok: boolean;
  error: string | null;
  preActionMode?: RecordingEngineState['mode'];
  didStop?: boolean;
  state?: RecordingActionState | null;
}
export interface RecordingClip {
  id: string;
  fileName: string;
  relativePath: string;
  createdAt: string;
  modifiedAt?: string;
  byteLength?: number;
}
export interface RecordingClipDeleteResult {
  ok: boolean;
  id: string;
  removed: boolean;
  reason: 'unavailable' | 'not-found' | 'unsafe-path' | 'delete-failed' | 'unsupported-platform' | null;
}
export interface RecordingSettingsSaveResult {
  settings: RecordingSettings;
  hotkeys: RecordingEngineState['hotkeys'];
}
