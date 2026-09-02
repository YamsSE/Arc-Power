// User-facing recording messages stay independent of the bundled runtime's
// internal product name.

import type { DeviceInfo, RecordingEncoderState } from '../types.ts';

export const RECORDING_BITRATE_RANGES = {
  default: { min: 4000, max: 8000, step: 100, default: 8000, label: '4,000–8,000 Kbps' },
  '480p': { min: 1500, max: 2500, step: 100, default: 2000, label: '1,500–2,500 Kbps' },
  '720p': { min: 2500, max: 5000, step: 100, default: 3500, label: '2,500–5,000 Kbps' },
  '900p': { min: 3500, max: 7000, step: 100, default: 5000, label: '3,500–7,000 Kbps' },
  '1080p': { min: 4000, max: 8000, step: 100, default: 6000, label: '4,000–8,000 Kbps' },
  '1440p': { min: 8000, max: 12000, step: 100, default: 10000, label: '8,000–12,000 Kbps' },
  '4k': { min: 15000, max: 50000, step: 500, default: 20000, label: '15,000–25,000+ Kbps' },
} as const;

export function recordingBitrateRange(resolution: string) {
  return RECORDING_BITRATE_RANGES[resolution as keyof typeof RECORDING_BITRATE_RANGES] ?? RECORDING_BITRATE_RANGES.default;
}

export function clampRecordingBitrate(value: number, resolution: string): number {
  const range = recordingBitrateRange(resolution);
  const numeric = Number.isFinite(value) ? Math.round(value) : range.default;
  const clamped = Math.min(range.max, Math.max(range.min, numeric));
  return Math.round(clamped / range.step) * range.step;
}

export function normalizeRecordingBitrate(value: number, fallback = 8000): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface RecordingGpuEncoderRow {
  deviceKey: string | null;
  deviceName: string;
  encoderLabels: string[];
}

type RecordingGpuLike = Pick<DeviceInfo, 'name' | 'pciVendorId' | 'gpuVendor' | 'deviceKey'>;
type RecordingEncoderLike = Pick<RecordingEncoderState, 'type' | 'description' | 'probeValid' | 'startTested' | 'startSupported'> & {
  deviceKey?: string | null;
  deviceName?: string | null;
  adapterName?: string | null;
  gpuName?: string | null;
};

function encoderInventoryLabel(encoder: RecordingEncoderLike): string {
  const source = `${encoder.type} ${encoder.description}`.toLowerCase();
  if (source.includes('av1')) return 'AV1';
  if (source.includes('hevc') || source.includes('h.265') || source.includes('h265')) return 'HEVC';
  if (source.includes('h264') || source.includes('h.264') || source.includes('avc') || encoder.type === 'obs_qsv11_v2') return 'H.264';
  return encoder.description || encoder.type;
}

function encoderIsUsable(encoder: RecordingEncoderLike): boolean {
  if (!encoder?.type || encoder.probeValid === false) return false;
  return !(encoder.startTested === true && encoder.startSupported !== true);
}

function intelGpu(device: RecordingGpuLike): boolean {
  const vendor = `${device?.gpuVendor ?? ''}`.toLowerCase();
  const pciVendor = String(device?.pciVendorId ?? '').replace(/^0x/i, '').toLowerCase();
  return vendor.includes('intel') || pciVendor.slice(-4) === '8086'
    || /\b(?:arc|iris|uhd)\b/i.test(device?.name ?? '');
}

function metadataOf(encoder: RecordingEncoderLike): { key: string | null; name: string | null } {
  const key = [encoder.deviceKey].find((value) => typeof value === 'string' && value.trim()) ?? null;
  const name = [encoder.deviceName, encoder.adapterName, encoder.gpuName]
    .find((value) => typeof value === 'string' && value.trim()) ?? null;
  return { key: key ? key.trim() : null, name: name ? name.trim() : null };
}

function metadataMatchesDevice(metadata: { key: string | null; name: string | null }, device: RecordingGpuLike): boolean {
  if (metadata.key && device.deviceKey) return metadata.key === device.deviceKey;
  if (metadata.name) return metadata.name.toLowerCase() === String(device.name ?? '').toLowerCase();
  return false;
}

/**
 * Build the recording page's adapter/codec inventory from stable GPU rows.
 * The current QSV runtime may expose codec support without an adapter field;
 * in that case every enumerated Intel GPU gets the verified codec list. This
 * keeps a multi-GPU machine honest without pretending that the runtime has a
 * per-adapter start selector when it does not.
 */
export function recordingGpuEncoderRows(
  devices: RecordingGpuLike[] = [],
  encoders: RecordingEncoderLike[] = [],
): RecordingGpuEncoderRow[] {
  const usable = (Array.isArray(encoders) ? encoders : []).filter(encoderIsUsable);
  const labels = [...new Set(usable.map(encoderInventoryLabel).filter(Boolean))];
  if (!labels.length) return [];

  const gpuDevices = (Array.isArray(devices) ? devices : []).filter(intelGpu);
  const annotated = usable.map((encoder) => ({ encoder, metadata: metadataOf(encoder) }));
  const hasAdapterMetadata = annotated.some(({ metadata }) => metadata.key || metadata.name);
  const rows: RecordingGpuEncoderRow[] = [];

  for (const device of gpuDevices) {
    const deviceLabels = hasAdapterMetadata
      ? annotated
        .filter(({ metadata }) => !metadata.key && !metadata.name || metadataMatchesDevice(metadata, device))
        .map(({ encoder }) => encoderInventoryLabel(encoder))
      : labels;
    const uniqueLabels = [...new Set(deviceLabels)].filter(Boolean);
    if (uniqueLabels.length) rows.push({ deviceKey: device.deviceKey ?? null, deviceName: device.name, encoderLabels: uniqueLabels });
  }

  // Preserve an adapter-labelled runtime entry even when Windows inventory
  // could not join it. It is still more useful than silently dropping it.
  for (const { encoder, metadata } of annotated) {
    if (!metadata.key && !metadata.name) continue;
    if (gpuDevices.some((device) => metadataMatchesDevice(metadata, device))) continue;
    rows.push({ deviceKey: metadata.key, deviceName: metadata.name ?? 'Detected GPU', encoderLabels: [encoderInventoryLabel(encoder)] });
  }

  // A non-Intel runtime entry is unusual for this QSV-only capture path, but
  // keep the capability visible instead of hiding it when the OS inventory is
  // temporarily unavailable.
  return rows.length ? rows : [{ deviceKey: null, deviceName: 'Detected GPU', encoderLabels: labels }];
}

export function recordingMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/ascent(?:-obs)?/gi, 'recording engine');
}
