// Arc Power — ambient declaration of the preload bridge (`window.arcPower`).
// The bridge is exposed by src/preload.cjs via contextBridge; the renderer
// never touches ipcRenderer directly. Channel whitelist + payload validation
// live in src/main/ipc-core.js — this type mirrors that contract.

import type {
  ApplyResponse,
  Capabilities,
  DeviceInfo,
  DeviceState,
  HealthReport,
  IgsActionResult,
  IgsServiceState,
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
  resetToDefaults(deviceId: number): Promise<ResetResponse>;
  waiverGet(deviceId: number): Promise<{ accepted: boolean }>;
  waiverAccept(deviceId: number): Promise<{ accepted: boolean }>;
  telemetryStart(deviceId: number): Promise<void>;
  telemetryStop(deviceId: number): Promise<void>;
  getIgsServiceState(): Promise<IgsServiceState>;
  disableIgsService(): Promise<IgsActionResult>;
  enableIgsService(): Promise<IgsActionResult>;
  onTelemetrySample(cb: (sample: TelemetrySample) => void): () => void;
}

declare global {
  interface Window {
    arcPower: ArcPowerApi;
  }
}
