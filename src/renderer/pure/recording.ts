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

export const RECORDING_GPU_ENCODER_SELECTION_PREFIX = 'arc-gpu-encoder:v1:';
const RECORDING_ENCODER_SELECTION_MAX_LENGTH = 128;
const RECORDING_QSV_ENCODER_IDS = ['obs_qsv11_av1', 'obs_qsv11_hevc', 'obs_qsv11_v2'] as const;

export interface RecordingAdapterBdf {
  domain: number;
  bus: number;
  device: number;
  function: number;
}

export interface RecordingAdapterTarget {
  deviceKey?: string;
  bdf?: RecordingAdapterBdf;
  luid?: string;
}

export interface RecordingEncoderSelection {
  codec: string;
  target: RecordingAdapterTarget;
  deviceName?: string;
}

type RecordingGpuLike = Pick<DeviceInfo, 'name' | 'pciVendorId' | 'gpuVendor' | 'deviceKey'> & {
  bdf?: Partial<RecordingAdapterBdf> | null;
  osController?: { luid?: unknown } | null;
  osLuid?: unknown;
};
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

function integerOf(value: unknown): number | null {
  if (typeof value === 'string' && !value.trim()) return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function luidOf(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value) && value.length >= 2) {
    const low = luidOf(value[0]);
    const high = luidOf(value[1]);
    return low && high ? `${high}:${low}` : null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const low = record.low ?? record.LowPart ?? record.lowPart;
  const high = record.high ?? record.HighPart ?? record.highPart;
  if (low !== undefined && high !== undefined) {
    const lowText = luidOf(low);
    const highText = luidOf(high);
    return lowText && highText ? `${highText}:${lowText}` : null;
  }
  return null;
}

function bdfOf(value: RecordingGpuLike['bdf'] | readonly unknown[]): RecordingAdapterBdf | null {
  if (!value) return null;
  const source = (Array.isArray(value)
    ? { domain: value[0], bus: value[1], device: value[2], function: value[3] }
    : value) as Partial<RecordingAdapterBdf>;
  const domain = integerOf(source.domain) ?? 0;
  const bus = integerOf(source.bus);
  const device = integerOf(source.device);
  const func = integerOf(source.function);
  if (bus === null || device === null || func === null || domain < 0 || bus < 0 || device < 0 || func < 0) return null;
  return { domain, bus, device, function: func };
}

export function recordingAdapterTargetOf(device: RecordingGpuLike): RecordingAdapterTarget | null {
  const target: RecordingAdapterTarget = {};
  const deviceKey = typeof device?.deviceKey === 'string' && device.deviceKey.trim() ? device.deviceKey.trim() : null;
  if (deviceKey) target.deviceKey = deviceKey;
  const bdf = bdfOf(device?.bdf);
  if (bdf) target.bdf = bdf;
  const luid = luidOf(device?.osLuid ?? device?.osController?.luid);
  if (luid) target.luid = luid;
  return Object.keys(target).length ? target : null;
}

function normalizedTarget(value: unknown): RecordingAdapterTarget | null {
  if (!value || typeof value !== 'object') return null;
  const target = value as Record<string, unknown>;
  const deviceKey = typeof target.deviceKey === 'string' && target.deviceKey.trim() ? target.deviceKey.trim() : undefined;
  const bdfValue = target.bdf && typeof target.bdf === 'object' ? target.bdf as RecordingGpuLike['bdf'] | readonly unknown[] : null;
  const bdf = bdfOf(bdfValue);
  const luid = luidOf(target.luid) ?? undefined;
  if (!deviceKey && !bdf && !luid) return null;
  return {
    ...(deviceKey ? { deviceKey } : {}),
    ...(bdf ? { bdf } : {}),
    ...(luid ? { luid } : {}),
  };
}

function compactTargetOf(target: RecordingAdapterTarget): Record<string, unknown> {
  // The runtime resolves encoder hardware through the DXGI LUID. Keep BDF and
  // deviceKey as app-side identity evidence, but never reduce a concrete
  // encoder choice to an ordinal or to a BDF that the recording runtime cannot
  // resolve by itself.
  if (target.luid) return { l: target.luid };
  if (target.bdf) return { b: [target.bdf.domain, target.bdf.bus, target.bdf.device, target.bdf.function] };
  return { k: target.deviceKey };
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeRecordingEncoderSelection(codec: string, device: RecordingGpuLike): string | null {
  if (!RECORDING_QSV_ENCODER_IDS.includes(codec as typeof RECORDING_QSV_ENCODER_IDS[number])) return null;
  const target = recordingAdapterTargetOf(device);
  if (!target) return null;
  const encoded = `${RECORDING_GPU_ENCODER_SELECTION_PREFIX}${base64UrlEncode(JSON.stringify({ c: codec, ...compactTargetOf(target) }))}`;
  return encoded.length <= RECORDING_ENCODER_SELECTION_MAX_LENGTH ? encoded : null;
}

export function parseRecordingEncoderSelection(value: string): RecordingEncoderSelection | null {
  if (typeof value !== 'string' || !value.startsWith(RECORDING_GPU_ENCODER_SELECTION_PREFIX)) return null;
  try {
    const encoded = value.slice(RECORDING_GPU_ENCODER_SELECTION_PREFIX.length);
    let parsed: unknown;
    try {
      parsed = JSON.parse(base64UrlDecode(encoded));
    } catch {
      // Accept the first development-format IDs as a migration courtesy.
      parsed = JSON.parse(decodeURIComponent(encoded));
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const codec = typeof record.codec === 'string' ? record.codec : record.c;
    if (typeof codec !== 'string' || !RECORDING_QSV_ENCODER_IDS.includes(codec as typeof RECORDING_QSV_ENCODER_IDS[number])) return null;
    const compactTarget = record.target ?? {
      ...(typeof record.k === 'string' ? { deviceKey: record.k } : {}),
      ...(Array.isArray(record.b) ? { bdf: record.b } : {}),
      ...(record.l !== undefined ? { luid: record.l } : {}),
    };
    const target = normalizedTarget(compactTarget);
    if (!target) return null;
    const deviceName = typeof record.deviceName === 'string' && record.deviceName.trim() ? record.deviceName.trim() : undefined;
    return { codec, target, ...(deviceName ? { deviceName } : {}) };
  } catch {
    return null;
  }
}

function encoderShortLabel(encoder: RecordingEncoderLike): 'AV1' | 'HEVC' | 'H264' | null {
  const source = `${encoder.type} ${encoder.description}`.toLowerCase();
  if (source.includes('av1')) return 'AV1';
  if (source.includes('hevc') || source.includes('h.265') || source.includes('h265')) return 'HEVC';
  if (source.includes('h264') || source.includes('h.264') || source.includes('avc') || encoder.type === 'obs_qsv11_v2') return 'H264';
  return null;
}

function deviceShortLabel(device: RecordingGpuLike): string {
  const name = String(device?.name ?? '').trim();
  const sku = name.match(/\b[AB]\d{3}\b/i)?.[0];
  if (sku) return sku.toUpperCase();
  const compact = name
    .replace(/Intel\s*\(R\)|Intel\s+/gi, '')
    .replace(/\(TM\)/gi, '')
    .replace(/Graphics?/gi, '')
    .replace(/\b\d+\s*GB\s+GDDR\w+\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return compact || 'GPU';
}

export function recordingGpuEncoderOptions(
  devices: RecordingGpuLike[] = [],
  encoders: RecordingEncoderLike[] = [],
): Array<[string, string]> {
  const usable = (Array.isArray(encoders) ? encoders : [])
    .filter(encoderIsUsable)
    .filter((encoder) => RECORDING_QSV_ENCODER_IDS.includes(encoder.type as typeof RECORDING_QSV_ENCODER_IDS[number]));
  const gpuDevices = (Array.isArray(devices) ? devices : [])
    .filter(intelGpu)
    .map((device) => ({ device, target: recordingAdapterTargetOf(device) }))
    .filter((entry): entry is { device: RecordingGpuLike; target: RecordingAdapterTarget } => Boolean(entry.target));
  const annotated = usable.map((encoder) => ({ encoder, metadata: metadataOf(encoder) }));
  const hasAdapterMetadata = annotated.some(({ metadata }) => metadata.key || metadata.name);
  const options: Array<[string, string]> = [];

  for (const encoderId of RECORDING_QSV_ENCODER_IDS) {
    const codec = usable.find((encoder) => encoder.type === encoderId);
    if (!codec) continue;
    const codecLabel = encoderShortLabel(codec);
    if (!codecLabel) continue;
    for (const { device, target } of gpuDevices) {
      const matchingMetadata = annotated.find(({ encoder, metadata }) => encoder.type === encoderId
        && ((metadata.key && device.deviceKey && metadata.key === device.deviceKey)
          || (metadata.name && metadata.name.toLowerCase() === String(device.name ?? '').toLowerCase())));
      if (hasAdapterMetadata && !matchingMetadata && annotated.some(({ encoder, metadata }) => encoder.type === encoderId && (metadata.key || metadata.name))) continue;
      const id = encodeRecordingEncoderSelection(encoderId, device);
      if (id) options.push([id, `${deviceShortLabel(device)} ${codecLabel}`]);
    }
  }
  return options;
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
