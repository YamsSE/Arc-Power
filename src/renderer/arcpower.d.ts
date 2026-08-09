// Arc Power - ambient declaration of the preload bridge (`window.arcPower`).
// The bridge is exposed by src/preload.cjs via contextBridge; the renderer
// never touches ipcRenderer directly. Channel whitelist + payload validation
// live in src/main/ipc-core.js - this type mirrors that contract.

import type {
  ApplyResponse,
  Capabilities,
  DeviceInfo,
  DeviceState,
  ElevationState,
  FpsSample,
  GraphicsApplyResponse,
  GraphicsSettings,
  GraphicsState,
  HealthReport,
  MockFeaturesetsResponse,
  MockSwapResponse,
  OverlaySettings,
  OverlayState,
  Profile,
  ProfilesEnvelope,
  ProfileSettingsState,
  RegistryCatalogResponse,
  RegistryApplyResponse,
  ResetResponse,
  Settings,
  StartupGetState,
  SysInfo,
  TelemetrySample,
} from './types.ts';

export interface ArcPowerApi {
  health(): Promise<HealthReport>;
  listDevices(): Promise<DeviceInfo[]>;
  /** M4-F: the persisted GPU selection (null when absent - devices[0] resolves at boot). */
  deviceGet(): Promise<{ deviceId: number | null }>;
  /** M4-F: persist the selected GPU (non-negative integer; the ONLY writer,
   *  like oc-mode-set - a Settings/Profiles save never clobbers it). */
  deviceSet(deviceId: number): Promise<{ deviceId: number | null }>;
  getCapabilities(deviceId: number): Promise<Capabilities>;
  getCurrentSettings(deviceId: number): Promise<DeviceState>;
  /** M8 (the Graphics tab): the 3D-feature read (never throws - the
   *  all-false/null state is the honest "not supported on this GPU" degrade).
   *  NEVER called with a null deviceId - the no-Intel page guard renders
   *  'No GPU available.' first. */
  graphicsGet(deviceId: number): Promise<GraphicsState>;
  /** M8: apply graphics settings - the DEDICATED apply path (NO OC waiver,
   *  NO OC-mode gate). Returns the { ok, perControl, graphicsState } envelope
   *  with the FRESH read-back for the per-control refresh. */
  graphicsApply(deviceId: number, settings: GraphicsSettings): Promise<GraphicsApplyResponse>;
  /** M4O: `opts.profileApply: true` marks a PROFILE apply (the Profiles-page
   *  Apply button) - main skips the OC-mode gate for it (the mode is the
   *  interactive slider gate ONLY; the ceiling + capability refusals stay). */
  applySettings(deviceId: number, settings: Settings, opts?: { profileApply?: boolean }): Promise<ApplyResponse>;
  resetToDefaults(deviceId: number): Promise<ResetResponse>;
  waiverGet(deviceId: number): Promise<{ accepted: boolean }>;
  waiverAccept(deviceId: number): Promise<{ accepted: boolean }>;
  /** 1.0.1 no-Intel round: telemetryStart(null) starts the no-device mode
   *  (a sentinel-keyed timer pushing sys-stats-ONLY samples). A non-negative
   *  integer starts the per-device telemetry. */
  telemetryStart(deviceId: number | null): Promise<void>;
  /** 1.0.1 no-Intel round: telemetryStop(null) is the symmetric stop for
   *  the no-device mode. */
  telemetryStop(deviceId: number | null): Promise<void>;
  /** M3-A (read-side only): the registry-hacks catalog + live states. */
  registryCatalog(): Promise<RegistryCatalogResponse>;
  /** M3-B: apply one catalog action ELEVATED (Enable/Disable/Revert per the
   *  entry's apply descriptor; main resolves the commands - the renderer
   *  never sends raw reg commands). */
  registryApply(entryId: string, action: 'enable' | 'disable' | 'revert'): Promise<RegistryApplyResponse>;
  startupGet(): Promise<StartupGetState>;
  /** M4-D2: enable/disable the HKCU Run value (the bare "<exe>" - the ONE
   *  registration shared by Start with Windows and start-at-boot; zero
   *  UAC). Returns the composed derivation. */
  startupSet(enabled: boolean): Promise<StartupGetState>;
  /** M4-D: the CIM system info (CPU/RAM/video controllers) - the dashboard
   *  CPU card + the real-GPU VRAM suffix source. */
  sysinfo(): Promise<SysInfo>;
  /** M4-D: integrated-title-bar window controls (no payload). */
  windowMinimize(): Promise<void>;
  windowMaximizeToggle(): Promise<void>;
  windowClose(): Promise<void>;
  /** M4-H: the sidebar GitHub link - opens the URL in the default browser
   *  (shell.openExternal in main). STRICTLY validated: https: + github.com
   *  + the '/YamsSE/Arc-Power' path - anything else rejects. */
  openExternal(url: string): Promise<void>;
  driverInfo(): Promise<{ driverDate: string | null }>;
  /** M2C-B B3: the app version for the header line ("Arc Power Ver. X.XX"). */
  appVersion(): Promise<{ version: string }>;
  /** M4-E: the distribution kind - 'installed' (elevated logon task story),
   *  'portable' (unelevated in-app applies), 'dev' (dev tree). */
  appBuildInfo(): Promise<{ kind: 'installed' | 'portable' | 'dev' }>;
  /** M4N (A.1): the window-path boot apply's outcome record ({ ok, detail,
   *  at }) or null when no boot apply ran this session. The renderer's boot
   *  fetch stores it as lastApply - the dashboard OC Status row flips green
   *  after a successful boot apply (the apply runs in main before the
   *  window exists; this fetch is how the renderer learns the result). */
  bootApplyOutcome(): Promise<{ ok: boolean; detail: string; at: number } | null>;
  /** M2C-C: elevation state (cached koffi probe, no spawn). */
  appElevated(): Promise<ElevationState>;
  /** M3-C-E: the persisted OC mode ('stock'|'advanced'). */
  ocModeGet(): Promise<{ ocMode: 'stock' | 'advanced' }>;
  /** M3-C-E: persist + activate the OC mode; invalidates the caps cache
   *  (the renderer re-fetches caps after the toggle). */
  ocModeSet(ocMode: 'stock' | 'advanced'): Promise<{ ocMode: 'stock' | 'advanced' }>;
  /** M4-B: whether the Advanced OC Mode warning was already accepted
   *  (persisted - a re-boot must not re-ask). */
  advancedModeAcceptedGet(): Promise<{ accepted: boolean }>;
  /** M4-B: persist the once-only Advanced OC Mode warning acceptance. */
  advancedModeAcceptedSet(): Promise<{ accepted: boolean }>;
  fpsPoll(deviceId: number): Promise<FpsSample | null>;
  /** M4-D2 (user)/M4J: append one full telemetry sample as an ALIGNED
   *  fixed-width line (Log to file - monitor-YYYYMMDD.txt). The writer
   *  reports { ok, file } - the file is the resolved log path the
   *  Monitoring page shows. Never throws (IO errors -> ok:false). The
   *  optional fps rides along (the renderer's latest FPS, best-effort -
   *  the sample itself carries the rest of the 12 fields). */
  monitorLogAppend(sample: TelemetrySample & { fps?: number | null }): Promise<{ ok: boolean; error?: string; file?: string }>;
  profilesList(): Promise<ProfilesEnvelope>;
  profilesSave(profile: Partial<Profile> & { id: string; name: string; settings: Settings; ocOnBoot: boolean }): Promise<ProfilesEnvelope>;
  profilesDelete(id: string): Promise<ProfilesEnvelope>;
  profilesRename(id: string, name: string): Promise<ProfilesEnvelope>;
  profilesSettingsSave(patch: Partial<ProfileSettingsState>): Promise<ProfileSettingsState>;
  trayRebuild(): Promise<{ ok: boolean }>;
  /** M2D (mock mode only): the featureset list + current selection for the
   *  header dropdown. The channel is absent in real mode (invoke rejects). */
  mockListFeaturesets(): Promise<MockFeaturesetsResponse>;
  /** M2D (mock mode only): swap the mock device featureset live; the whole
   *  UI surface (caps/ranges/units/telemetry) re-renders from the response. */
  mockSetFeatureset(id: string): Promise<MockSwapResponse>;
  /** M4-D2 (mock mode only): run the REAL window-path boot-apply code path
   *  (applyRunner-less, defaults-fallback skipped) and record the attempt
   *  in the session mock apply log. */
  mockRunBootApply(): Promise<{ applied: boolean; reason?: string | null; log: unknown[] }>;
  /** M4-D2 (mock mode only): the session's mock boot-apply log (what the
   *  REAL boot-apply flow recorded). */
  mockBootApplyLog(): Promise<Array<{ profileId: string; applied: boolean; reason: string | null; at: number }>>;
  onTelemetrySample(cb: (sample: TelemetrySample) => void): () => void;
  /** M4-D: pushed window-maximize state ({ maximized: boolean } on
   *  maximize/unmaximize - the title-bar max button follows it). */
  onWindowMaximizedChanged(cb: (state: { maximized: boolean }) => void): () => void;
  /** M5: pushed overlay settings (the Overlay window surface) - the scale
   *  source of truth, sent by main on every apply (incl. the initial
   *  did-finish-load push; the renderer registers this SYNCHRONOUSLY at
   *  script top so the initial push is never missed). */
  onOverlaySettings(cb: (settings: OverlaySettings) => void): () => void;
  /** M5: the overlay window's live state (the Settings Overlay card
   *  re-queries it on every render - hotkeyRegistered is live-derived). */
  overlayGetState(): Promise<OverlayState>;
  /** M5: flip the overlay's visibility (the Settings toggle + the hotkey
   *  flip the same persisted field). Returns the fresh state. */
  overlayToggle(): Promise<OverlayState>;
}

declare global {
  interface Window {
    arcPower: ArcPowerApi;
  }
}
