// Arc Power - ambient declaration of the preload bridge (`window.arcPower`).
// The bridge is exposed by src/preload.cjs via contextBridge; the renderer
// never touches ipcRenderer directly. Channel whitelist + payload validation
// live in src/main/ipc-core.js - this type mirrors that contract.

import type {
  ApplyResponse,
  AdvancedOverlaySettings,
  AdvancedOverlayState,
  Capabilities,
  DeviceInfo,
  DeviceState,
  GameApplication,
  GameAssociation,
  GameProfileCapabilities,
  GameProfilesEnvelope,
  DisplayApplyResponse,
  DisplaySettings,
  DisplayState,
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
  PowerLimitsRead,
  RegistryCatalogResponse,
  RegistryApplyResponse,
  RecordingClip,
  RecordingClipDeleteResult,
  RecordingCaptureTargets,
  RecordingEngineState,
  RecordingActionResult,
  RecordingNotification,
  RecordingSettingsSaveResult,
  RecordingSettings,
  RecordingSettingsPatch,
  RecordingStorageInfo,
  ResetResponse,
  Settings,
  StartupGetState,
  SysInfo,
  TelemetrySample,
  VendorDeviceInfo,
} from './types.ts';

export interface DeviceSelectionPayload {
  deviceId: number;
  deviceKey: string | null;
  /** Main-renderer monotonic session generation; omitted by legacy callers. */
  selectionGeneration?: number;
  caps: Capabilities;
  state: DeviceState;
}

export interface ArcPowerApi {
  health(): Promise<HealthReport>;
  listDevices(): Promise<DeviceInfo[]>;
  /** M29: persisted GPU selection (numeric id + durable PCI/BDF key). */
  deviceGet(): Promise<{ deviceId: number | null; deviceKey: string | null }>;
  /** M151: automatic startup focus; read-only and not a persisted setting. */
  devicePreferredGet(): Promise<{ deviceId: number | null; deviceKey: string | null }>;
  /** Main-renderer monotonic selection generation, for reload-safe handshakes. */
  deviceSelectionGenerationGet(): Promise<{ generation: number }>;
  /** Persist the selected GPU and its stable identity. */
  deviceSet(selection: number | { deviceId: number; deviceKey?: string }): Promise<{ deviceId: number | null; deviceKey?: string | null }>;
  /** M31: the Advanced Overlay asks the main renderer to switch by durable key. */
  deviceSelectionRequest(deviceKey: string): Promise<{ accepted: boolean }>;
  /** M31: the main renderer publishes its atomic caps/state selection pair. */
  deviceSelectionPush(payload: DeviceSelectionPayload): Promise<{ accepted: boolean }>;
  getCapabilities(deviceId: number): Promise<Capabilities>;
  getCurrentSettings(deviceId: number): Promise<DeviceState>;
  /** M17f: the sysman PL2 read-out ({ sustainedW, burstW, peakW } when the
   *  sysman layer answers, null when absent - the power-limit card's PL2
   *  line; never throws). M17f (step-4 N2): DEVICE-SCOPED like every read
   *  channel - the domain is per-device. */
  powerLimitsRead(deviceId: number): Promise<PowerLimitsRead | null>;
  /** M8 (the Graphics tab): the 3D-feature read (never throws - the
   *  all-false/null state is the honest "not supported on this GPU" degrade).
   *  NEVER called with a null deviceId - the no-Intel page guard renders
   *  'No GPU available.' first. */
  graphicsGet(deviceId: number): Promise<GraphicsState>;
  /** M8: apply graphics settings - the DEDICATED apply path (NO OC waiver,
   *  NO OC-mode gate). Returns the { ok, perControl, graphicsState } envelope
   *  with the FRESH read-back for the per-control refresh. */
  graphicsApply(deviceId: number, settings: GraphicsSettings): Promise<GraphicsApplyResponse>;
  /** M10b (the Graphics "Display" view): the display-output read (never
   *  throws - { displays: [] } is the honest no-controls degrade). NEVER
   *  called with a null deviceId - the no-Intel page guard renders
   *  'No GPU available.' first (assertValidDeviceId would throw). */
  displayGet(deviceId: number): Promise<DisplayState>;
  /** Apply display settings for ONE display by the stable physical key from
   *  the display:get payload - the DEDICATED apply path (NO OC waiver, NO
   *  OC-mode gate). Returns the { ok, perControl, displayState } envelope
   *  with the FRESH read-back for the per-control refresh. */
  displayApply(deviceId: number, request: { deviceKey: string; displayKey: string; patch: DisplaySettings }): Promise<DisplayApplyResponse>;
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
  telemetryLatest(deviceId: number): Promise<TelemetrySample | null>;
  /** Basic Overlay secondary-adapter lanes; an empty list hides GPU2. */
  overlayTelemetryStart(deviceIds: number[]): Promise<void>;
  /** Resize the Basic Overlay after its all-device inventory is rendered. */
  overlayResize(deviceCount: number): Promise<void>;
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
  /** M17d (round-1 S2): the vendor-lane static info - the no-Intel
   *  dashboard VRAM/Compute rows' source ({ vramBytes, computeCores } - the
   *  NVML total + core count; honest nulls when no vendor adapter resolves:
   *  no lane / absent DLL / a vendor without the field - ADL). */
  vendorInfo(deviceId?: number): Promise<VendorDeviceInfo>;
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
  /** M52: clear disposable cache and request a graceful application restart. */
  appClearCacheAndRestart(): Promise<{ ok: boolean; restarting: boolean }>;
  /** M4N (A.1): the window-path boot apply's outcome record ({ ok, detail,
   *  at }) or null when no boot apply ran this session. M16: the dashboard
   *  OC status row no longer displays the record - the row's stock-state
   *  verdict derives from the driver read-back; the channel stays for the
   *  boot-apply ui-verify pins (window.arcPower.bootApplyOutcome). */
  bootApplyOutcome(): Promise<{ ok: boolean; detail: string; at: number } | null>;
  /** M2C-C: elevation state (cached koffi probe, no spawn). */
  appElevated(): Promise<ElevationState>;
  /** M3-C-E/M157: get the Stock/Advanced mode for one physical GPU. */
  ocModeGet(deviceId?: number | null): Promise<{ ocMode: 'stock' | 'advanced'; deviceKey?: string | null }>;
  /** M3-C-E/M157: persist + activate the mode for one physical GPU; the
   * renderer re-fetches that GPU's caps after the toggle. */
  ocModeSet(ocMode: 'stock' | 'advanced', deviceId?: number | null): Promise<{ ocMode: 'stock' | 'advanced'; deviceKey?: string | null }>;
  /** M4-B: whether the Advanced OC Mode warning was already accepted
   *  (persisted - a re-boot must not re-ask). */
  advancedModeAcceptedGet(): Promise<{ accepted: boolean }>;
  /** M4-B: persist the once-only Advanced OC Mode warning acceptance. */
  advancedModeAcceptedSet(): Promise<{ accepted: boolean }>;
  fpsPoll(deviceId: number): Promise<FpsSample | null>;
  /** M4-D2/M4J: append one full telemetry sample as an ALIGNED
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
  gamesScan(): Promise<{ apps: GameApplication[]; error?: string; sidecarError?: string }>;
  gameCatalogList(): Promise<GameCatalogEnvelope>;
  gameCatalogAdd(): Promise<GameCatalogEnvelope & { canceled: boolean }>;
  gameProfileCapabilities(deviceId: number, exePath?: string): Promise<GameProfileCapabilities>;
  gameCatalogSync(apps: GameApplication[]): Promise<{ catalog: GameCatalogEntry[] }>;
  gameSettingsSave(settings: Partial<GameSettingsRecord> & { exePath: string }): Promise<{ settings: GameSettingsRecord; apply?: { ok: boolean; skipped?: boolean; errorCode?: string; message?: string; perControl?: Record<string, unknown> } }>;
  gameSettingsDelete(settings: { exePath: string }): Promise<GameCatalogEnvelope>;
  gameProfilesList(): Promise<GameProfilesEnvelope>;
  gameProfileSave(association: Partial<GameAssociation> & { profileId: string; exePath: string }): Promise<GameProfilesEnvelope>;
  gameProfileDelete(association: { profileId: string; exePath: string }): Promise<GameProfilesEnvelope>;
  trayRebuild(): Promise<{ ok: boolean }>;
  recordingSettingsGet(): Promise<RecordingSettings>;
  recordingSettingsSave(patch: RecordingSettingsPatch): Promise<RecordingSettingsSaveResult>;
  recordingRuntimeProbe(): Promise<RecordingEngineState>;
  recordingStatus(): Promise<RecordingEngineState>;
  recordingStart(): Promise<{ state: RecordingEngineState; outputPath: string }>;
  recordingStop(mode?: 'video' | 'replay' | null): Promise<RecordingEngineState>;
  recordingReplayStart(): Promise<{ state: RecordingEngineState; outputPath: null }>;
  recordingClipSave(payload?: { headDurationMs?: number }): Promise<{ response: unknown; outputPath: string }>;
  recordingClipsList(): Promise<RecordingClip[]>;
  recordingStorageInfo(): Promise<RecordingStorageInfo>;
  recordingCaptureTargets(refresh?: boolean): Promise<RecordingCaptureTargets>;
  recordingProcessesList(): Promise<string[]>;
  recordingChooseFolder(): Promise<{ canceled: boolean; location?: string; settings: RecordingSettings }>;
  recordingOpenFolder(): Promise<{ ok: boolean }>;
  recordingClipUrl(id: string): Promise<string>;
  recordingClipDelete(id: string): Promise<RecordingClipDeleteResult>;
  onRecordingStateUpdated(cb: (state: RecordingEngineState) => void): () => void;
  onRecordingActionResult(cb: (result: RecordingActionResult) => void): () => void;
  onRecordingNotification(cb: (notification: RecordingNotification) => void): () => void;
  /** M2D (mock mode only): the featureset list + current selection for the
   *  header dropdown. The channel is absent in real mode (invoke rejects). */
  mockListFeaturesets(): Promise<MockFeaturesetsResponse>;
  /** M2D (mock mode only): swap the mock device featureset live; the whole
   *  UI surface (caps/ranges/units/telemetry) re-renders from the response. */
  mockSetFeatureset(id: string): Promise<MockSwapResponse>;
  /** M31: panel-to-main selection requests, delivered only to the main renderer. */
  onDeviceSelectionRequested(cb: (payload: { deviceKey: string }) => void): () => void;
  /** M31: main-owned durable selection/caps/state push delivered to both renderers. */
  onDeviceSelectionUpdated(cb: (payload: DeviceSelectionPayload) => void): () => void;
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
  /** M16-F1: pushed POST-APPLY device read-backs ({ deviceId, state } on
   *  'device:state-updated') - the tray "Apply active profile" runs
   *  entirely in main, so main pushes the fresh read-back; the renderer
   *  refreshes its store `state` slot (the dashboard OC status row derives
   *  from the live read-back and must flip after a tray apply). */
  onStateUpdated(cb: (payload: { deviceId: number; state: DeviceState }) => void): () => void;
  /** M24 (Part B): pushed POST-APPLY GRAPHICS read-backs ({ deviceId,
   *  graphicsState } on 'graphics:state-updated') - the onStateUpdated twin
   *  for the graphics surface: the ipc.js wrap pushes the fresh read-back
   *  after every graphics:apply, and the main window's Graphics page + the
   *  advanced-overlay panel's Graphics tab re-render from it in place (the
   *  cross-window settings sync). */
  onGraphicsStateUpdated(cb: (payload: { deviceId: number; graphicsState: GraphicsState }) => void): () => void;
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
  /** M23: pushed ADVANCED-overlay settings ({ position, enabled,
   *  hotkeyLetter } - the panel window's surface; sent by main on every
   *  apply incl. the initial did-finish-load push - the panel registers
   *  SYNCHRONOUSLY at script top so the initial push is never missed). */
  onAdvancedOverlaySettings(cb: (settings: AdvancedOverlaySettings) => void): () => void;
  /** M23: the ADVANCED-overlay window's live state (the Overlay view's
   *  Advanced card re-queries it on every render - hotkeyRegistered is
   *  live-derived from the second hotkey seam). */
  advancedOverlayGetState(): Promise<AdvancedOverlayState>;
  /** M23: the ADVANCED-overlay shortcut flip (M7b fix-5 semantics: gated on
   *  the persisted advancedOverlayEnabled master - a no-op while the master
   *  is off; NEVER writes the master). Returns the fresh state. */
  advancedOverlayToggle(): Promise<AdvancedOverlayState>;
  /** M23: the ADVANCED-overlay's custom close button - a SESSION hide (the
   *  dedicated channel; the main window is never closed by the panel). */
  advancedOverlayClose(): Promise<void>;
  /** M25: check GitHub Releases for a newer version. */
  updateCheck(intent?: 'startup' | 'manual'): Promise<{ available: boolean; version?: string; assetUrl?: string; assetName?: string }>;
  /** M25: download a release asset to temp. */
  updateDownload(assetUrl: string): Promise<{ ok: boolean; path: string }>;
  /** M25: install a downloaded update and quit the app. */
  updateInstall(filePath: string): Promise<void>;
}

declare global {
  interface Window {
    arcPower: ArcPowerApi;
  }
}
