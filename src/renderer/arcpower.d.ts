// Arc Power — ambient declaration of the preload bridge (`window.arcPower`).
// The bridge is exposed by src/preload.cjs via contextBridge; the renderer
// never touches ipcRenderer directly. Channel whitelist + payload validation
// live in src/main/ipc-core.js — this type mirrors that contract.

import type {
  ApplyProgress,
  ApplyResponse,
  Capabilities,
  DeviceInfo,
  DeviceState,
  FpsSample,
  HealthReport,
  IgsActionResult,
  IgsServiceState,
  Profile,
  ProfilesEnvelope,
  ProfileSettingsState,
  ResetResponse,
  Settings,
  TelemetrySample,
} from './types.ts';

export interface ArcPowerApi {
  health(): Promise<HealthReport>;
  listDevices(): Promise<DeviceInfo[]>;
  getCapabilities(deviceId: number): Promise<Capabilities>;
  getCurrentSettings(deviceId: number): Promise<DeviceState>;
  applySettings(deviceId: number, settings: Settings): Promise<ApplyResponse>;
  /** F3: abort the in-flight apply for a device (live Apply button). */
  cancelApply(deviceId: number): Promise<{ ok: boolean }>;
  resetToDefaults(deviceId: number): Promise<ResetResponse>;
  waiverGet(deviceId: number): Promise<{ accepted: boolean }>;
  waiverAccept(deviceId: number): Promise<{ accepted: boolean }>;
  telemetryStart(deviceId: number): Promise<void>;
  telemetryStop(deviceId: number): Promise<void>;
  getIgsServiceState(): Promise<IgsServiceState>;
  disableIgsService(): Promise<IgsActionResult>;
  enableIgsService(): Promise<IgsActionResult>;
  startupGet(): Promise<{ enabled: boolean; profileId: string | null; value: string | null }>;
  startupSet(enabled: boolean, profileId: string | null): Promise<{ enabled: boolean; profileId: string | null; value: string | null }>;
  driverInfo(): Promise<{ driverDate: string | null }>;
  fpsPoll(deviceId: number): Promise<FpsSample | null>;
  profilesList(): Promise<ProfilesEnvelope>;
  profilesSave(profile: Partial<Profile> & { id: string; name: string; settings: Settings; ocOnBoot: boolean }): Promise<ProfilesEnvelope>;
  profilesDelete(id: string): Promise<ProfilesEnvelope>;
  profilesRename(id: string, name: string): Promise<ProfilesEnvelope>;
  profilesSettingsSave(patch: Partial<ProfileSettingsState>): Promise<ProfileSettingsState>;
  trayRebuild(): Promise<{ ok: boolean }>;
  onTelemetrySample(cb: (sample: TelemetrySample) => void): () => void;
  /** F3: live retry progress while an apply is running (deviceId-scoped). */
  onApplyProgress(cb: (progress: ApplyProgress) => void): () => void;
}

declare global {
  interface Window {
    arcPower: ArcPowerApi;
  }
}
