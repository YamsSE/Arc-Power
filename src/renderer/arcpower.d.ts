// Arc Power — ambient declaration of the preload bridge (`window.arcPower`).
// The bridge is exposed by src/preload.cjs via contextBridge; the renderer
// never touches ipcRenderer directly. Channel whitelist + payload validation
// live in src/main/ipc-core.js — this type mirrors that contract.

import type {
  ApplyResponse,
  Capabilities,
  DeviceInfo,
  DeviceState,
  ElevationState,
  FpsSample,
  HealthReport,
  MockFeaturesetsResponse,
  MockSwapResponse,
  Profile,
  ProfilesEnvelope,
  ProfileSettingsState,
  RegistryCatalogResponse,
  RegistryApplyResponse,
  ResetResponse,
  Settings,
  StartupState,
  TelemetrySample,
} from './types.ts';

export interface ArcPowerApi {
  health(): Promise<HealthReport>;
  listDevices(): Promise<DeviceInfo[]>;
  getCapabilities(deviceId: number): Promise<Capabilities>;
  getCurrentSettings(deviceId: number): Promise<DeviceState>;
  applySettings(deviceId: number, settings: Settings): Promise<ApplyResponse>;
  resetToDefaults(deviceId: number): Promise<ResetResponse>;
  waiverGet(deviceId: number): Promise<{ accepted: boolean }>;
  waiverAccept(deviceId: number): Promise<{ accepted: boolean }>;
  telemetryStart(deviceId: number): Promise<void>;
  telemetryStop(deviceId: number): Promise<void>;
  /** M3-A (read-side only): the registry-hacks catalog + live states. */
  registryCatalog(): Promise<RegistryCatalogResponse>;
  /** M3-B: apply one catalog action ELEVATED (Enable/Disable/Revert per the
   *  entry's apply descriptor; main resolves the commands — the renderer
   *  never sends raw reg commands). */
  registryApply(entryId: string, action: 'enable' | 'disable' | 'revert'): Promise<RegistryApplyResponse>;
  startupGet(): Promise<StartupState>;
  startupSet(enabled: boolean, profileId: string | null): Promise<StartupState>;
  driverInfo(): Promise<{ driverDate: string | null }>;
  /** M2C-B B3: the app version for the header line ("Arc Power Ver. X.XX"). */
  appVersion(): Promise<{ version: string }>;
  /** M2C-C: elevation state (cached koffi probe, no spawn). */
  appElevated(): Promise<ElevationState>;
  /** M3-C-E: the persisted OC mode ('stock'|'advanced'). */
  ocModeGet(): Promise<{ ocMode: 'stock' | 'advanced' }>;
  /** M3-C-E: persist + activate the OC mode; invalidates the caps cache
   *  (the renderer re-fetches caps after the toggle). */
  ocModeSet(ocMode: 'stock' | 'advanced'): Promise<{ ocMode: 'stock' | 'advanced' }>;
  /** M4-B: whether the Advanced OC Mode warning was already accepted
   *  (persisted — a re-boot must not re-ask). */
  advancedModeAcceptedGet(): Promise<{ accepted: boolean }>;
  /** M4-B: persist the once-only Advanced OC Mode warning acceptance. */
  advancedModeAcceptedSet(): Promise<{ accepted: boolean }>;
  fpsPoll(deviceId: number): Promise<FpsSample | null>;
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
  onTelemetrySample(cb: (sample: TelemetrySample) => void): () => void;
}

declare global {
  interface Window {
    arcPower: ArcPowerApi;
  }
}
